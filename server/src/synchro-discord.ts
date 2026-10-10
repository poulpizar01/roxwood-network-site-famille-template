// Rôles Discord relus par un bot entre deux connexions. Sans lui, un rôle retiré sur Discord (grade, rôle membre) ne
// comptait qu'à la connexion Discord suivante : jusqu'à 7 jours (durée d'une session) avec les anciens accès.
// Avec DISCORD_BOT_TOKEN (bot invité sur le serveur, sans aucune permission), toutes les 10 minutes, chaque compte validé
// ou en attente (hors propriétaire) est relu sur Discord et suit les règles de la connexion (grade-connexion.ts) :
//   - grade lié à un rôle retiré : perdu (grade par défaut) ; nouveau rôle lié : grade donné ;
//   - rôle membre retiré ou donné : accès au chat et aux pages du bot ajusté aussitôt (flux du chat revalidés) ;
//   - membre parti du serveur : ses sessions sont fermées et il est marqué parti (leftGuildAt) ; la connexion Discord
//     le refuse déjà (pas membre). Il redevient normal à sa prochaine connexion.
// Un appel par compte (« Get Guild Member », sans intention privilégiée à activer), espacés. Une erreur du bot (jeton
// refusé, Discord coupé) interrompt la passe sans rien changer : la suivante reprend. Sans jeton : rien ne tourne.
import { config } from './config.js';
import { prisma } from './db.js';
import { synchroMembre } from './grade-connexion.js';
import { allRanks } from './ranks.js';
import { oublierBot } from './routes/bot.js';
import { revaliderFluxPlusTard } from './routes/chat.js';
import { memberRoleId } from './settings.js';

const INTERVALLE_MS = 10 * 60_000, PREMIERE_MS = 2 * 60_000, ESPACEMENT_MS = 250;
const ID_DISCORD = /^\d{15,22}$/, MEMBRE_INCONNU = 10007;   // code d'erreur Discord : pas (plus) membre du serveur
const attendre = (ms: number) => new Promise(ok => setTimeout(ok, ms));
class ErreurDiscord extends Error {}

// rôles du membre sur le serveur, null s'il n'y est plus ; toute autre réponse interrompt la passe
async function rolesDuMembre(discordId: string): Promise<string[] | null> {
  for (let essai = 0; ; essai++) {
    let r: Response;
    try {
      r = await fetch(`https://discord.com/api/v10/guilds/${config.discord.guildId}/members/${discordId}`, {
        headers: { Authorization: `Bot ${config.discord.botToken}` }, signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new ErreurDiscord('Discord ne répond pas'); }
    const corps = await r.json().catch(() => null) as { roles?: unknown; code?: unknown; retry_after?: unknown } | null;
    if (r.ok && Array.isArray(corps?.roles)) return [...new Set(corps.roles.map(String).filter(x => ID_DISCORD.test(x)))].slice(0, 250);
    if (r.status === 404 && corps?.code === MEMBRE_INCONNU) return null;
    // limite de Discord : une attente courte, puis une seule nouvelle tentative
    const attente = Number(corps?.retry_after) || 0;
    if (r.status === 429 && essai === 0 && attente <= 60) { await attendre((attente + 1) * 1000); continue; }
    throw new ErreurDiscord(r.status === 401 ? 'jeton du bot refusé (DISCORD_BOT_TOKEN)' : r.status === 403 || r.status === 404 ? 'bot absent du serveur Discord' : `HTTP ${r.status}`);
  }
}

let enCours = false;
export async function synchroniserMembres(): Promise<{ lus: number; modifies: number; partis: number }> {
  const bilan = { lus: 0, modifies: 0, partis: 0 };
  if (enCours || !config.discord.botToken) return bilan;
  enCours = true;
  try {
    const membres = await prisma.member.findMany({
      where: { status: { in: ['approved', 'pending'] }, isOwner: false, leftGuildAt: null },
      select: { id: true, discordId: true },
    });
    for (const m of membres) {
      if (!ID_DISCORD.test(m.discordId)) continue;   // compte de dev local
      const roles = await rolesDuMembre(m.discordId);
      bilan.lus++;
      // relu au moment d'écrire : une connexion ou une modification faite entre-temps l'emporte
      const actuel = await prisma.member.findUnique({ where: { id: m.id }, select: { rankKey: true, memberRole: true, isOwner: true, leftGuildAt: true, status: true } });
      if (!actuel || actuel.isOwner || actuel.leftGuildAt || actuel.status === 'rejected') continue;
      const d = synchroMembre(allRanks(), actuel, roles, memberRoleId());
      if (d.parti) {
        await prisma.$transaction([
          prisma.member.update({ where: { id: m.id }, data: { leftGuildAt: new Date(), rankKey: d.rankKey, memberRole: null } }),
          prisma.$executeRaw`DELETE FROM "session" WHERE (sess->>'memberId') = ${String(m.id)}`,
        ]);
        oublierBot(m.id);
        bilan.partis++;
      } else if (d.change) {
        await prisma.member.update({ where: { id: m.id }, data: { rankKey: d.rankKey, memberRole: d.memberRole } });
        oublierBot(m.id);
        bilan.modifies++;
      }
      await attendre(ESPACEMENT_MS);
    }
  } finally {
    enCours = false;
    if (bilan.modifies || bilan.partis) revaliderFluxPlusTard();   // onglets du chat ouverts : accès ajusté aussitôt
  }
  if (bilan.modifies || bilan.partis) console.log(`[synchro discord] ${bilan.lus} compte(s) relu(s) : ${bilan.modifies} grade(s) ou rôle(s) membre mis à jour, ${bilan.partis} membre(s) parti(s) du serveur`);
  return bilan;
}

// premier passage peu après le démarrage, puis toutes les 10 minutes ; unref : ne retient pas l'arrêt du serveur
export function planifierSynchroDiscord(): void {
  if (!config.discord.botToken) return;
  const passe = () => synchroniserMembres().catch(e => console.error(`[synchro discord] passe interrompue : ${(e as Error).message}`));
  setTimeout(() => { passe(); setInterval(passe, INTERVALLE_MS).unref(); }, PREMIERE_MS).unref();
}
