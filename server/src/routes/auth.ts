// Connexion Discord (OAuth2), connexion de dev locale et déconnexion.
import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { gradeConnexion } from '../grade-connexion.js';
import { allRanks } from '../ranks.js';
import { oublierBot } from './bot.js';
import { fermerSession, revaliderFluxPlusTard } from './chat.js';
import { memberRoleId } from '../settings.js';

const DISCORD_API = 'https://discord.com/api/v10';
const REDIRECT_URI = `${config.baseUrl}/auth/discord/callback`;
const SCOPES = 'identify guilds guilds.members.read';   // guilds : savoir si l'utilisateur est propriétaire du serveur

type DiscordUser = { id: string; username: string; global_name: string | null; avatar: string | null };
type GuildMember = { nick: string | null; roles: string[] };
type UserGuild = { id: string; owner: boolean };

export const auth = Router();

// nouvelle session à chaque connexion (évite la fixation de session), puis rattachement du membre
const openSession = (req: Request, memberId: number) => new Promise<void>((ok, ko) =>
  req.session.regenerate(err => { if (err) ko(err); else { req.session.memberId = memberId; ok(); } }));

// Connexion de dev : seulement pour une requête arrivée directement sur la machine (adresse localhost, sans passer par
// un proxy). Derrière nginx, le Host est le domaine et nginx ajoute X-Forwarded-For : refusée même si DEV_LOGIN était
// activé par erreur en production.
const requeteLocale = (req: Request) =>
  /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '') && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];

auth.get('/auth/discord', async (req, res) => {
  if (config.devLogin) {
    if (!requeteLocale(req)) { res.status(403).send('Connexion de dev réservée à la machine locale.'); return; }
    // dev : ?compte=<ID Discord> ouvre la session d'un compte existant, pour essayer chaque niveau d'accès
    const autre = typeof req.query.compte === 'string' ? await prisma.member.findUnique({ where: { discordId: req.query.compte } }) : null;
    if (autre) {
      await openSession(req, autre.id);
      res.redirect(autre.status === 'approved' ? '/espace/profil.html' : '/espace/attente.html');
      return;
    }
    const m = await prisma.member.upsert({
      where: { discordId: config.devDiscordId },
      create: { discordId: config.devDiscordId, username: 'dev', displayName: 'Dev local', isOwner: true, status: 'approved', approvedAt: new Date(), lastLogin: new Date() },
      update: { isOwner: true, lastLogin: new Date() },
    });
    await openSession(req, m.id);
    res.redirect('/espace/profil.html');
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = new URL(`${DISCORD_API}/oauth2/authorize`);
  url.search = new URLSearchParams({ client_id: config.discord.clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES, state, prompt: 'none' }).toString();
  res.redirect(url.toString());
});

// Comptes encore marqués propriétaires alors qu'un autre l'est devenu : plus de pouvoirs d'office, et leur grade sans
// rôle Discord (celui donné d'office au propriétaire) revient au grade par défaut. Un grade lié à un rôle est gardé,
// revérifié à leur prochaine connexion.
async function retirerProprietaires(saufDiscordId: string) {
  const anciens = await prisma.member.findMany({ where: { isOwner: true, discordId: { not: saufDiscordId } }, select: { id: true, rankKey: true } });
  const parDefaut = allRanks().find(r => r.isDefault)?.key ?? null;
  for (const a of anciens) {
    const lie = !!allRanks().find(r => r.key === a.rankKey)?.discordRoleId;
    await prisma.member.update({ where: { id: a.id }, data: { isOwner: false, ...(!lie && { rankKey: parDefaut }) } });
  }
}

auth.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    // state obligatoire : sans connexion lancée depuis ce navigateur (rien en session), un retour forgé est refusé
    if (error || typeof code !== 'string' || typeof state !== 'string' || !state || state !== req.session.oauthState) { res.redirect('/espace/?error=oauth'); return; }
    delete req.session.oauthState;

    // 1. code → jeton (10 s au plus par appel : un Discord qui ne répond pas ne laisse pas la connexion pendue)
    const delai = () => AbortSignal.timeout(10000);
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.discord.clientId, client_secret: config.discord.clientSecret, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      signal: delai(),
    });
    if (!tokenRes.ok) { res.redirect('/espace/?error=token'); return; }
    const { access_token } = await tokenRes.json() as { access_token: string };
    const discord = (path: string) => fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bearer ${access_token}` }, signal: delai() });

    // 2. identité, appartenance au serveur (+ rôles), propriété du serveur. Une réponse en erreur de Discord (limite,
    // panne) interrompt la connexion sans toucher au compte : la lire comme « pas propriétaire » ou « pas membre »
    // retirerait ses droits à quelqu'un qui les a.
    const [userRes, memberRes, guildsRes] = [await discord('/users/@me'), await discord(`/users/@me/guilds/${config.discord.guildId}/member`), await discord('/users/@me/guilds')];
    if (memberRes.status === 404) { res.redirect('/espace/?error=not-member'); return; }
    if (!userRes.ok || !memberRes.ok || !guildsRes.ok) { res.redirect('/espace/?error=server'); return; }
    const user = await userRes.json() as DiscordUser, guildMember = await memberRes.json() as GuildMember, guilds = await guildsRes.json() as UserGuild[];
    // formes attendues : ces valeurs servent à construire l'adresse de l'avatar, insérée dans les pages
    if (!/^\d{5,32}$/.test(String(user.id)) || !Array.isArray(guildMember.roles) || !Array.isArray(guilds)) { res.redirect('/espace/?error=server'); return; }
    if (user.avatar && !/^(a_)?[0-9a-f]{32}$/.test(user.avatar)) user.avatar = null;
    const owner = guilds.some(g => g.id === config.discord.guildId && g.owner === true);
    const roleMembre = memberRoleId(), memberRole = roleMembre && guildMember.roles.includes(roleMembre) ? roleMembre : null;

    // 3. grade : règles dans grade-connexion.ts (rôle Discord porté, grade attribué à la main, ancien propriétaire) ;
    // nouveau compte = grade par défaut (propriétaire : premier grade à pouvoirs complets)
    const ranks = allRanks();
    const startRank = owner ? ranks.find(r => r.canManage)?.key : ranks.find(r => r.isDefault)?.key;

    // 4. compte : créé en attente de validation, validé d'office pour le propriétaire
    const existing = await prisma.member.findUnique({ where: { discordId: user.id } });
    const { grade: gradeRelu, parRole: rankFromRole } = gradeConnexion(ranks, guildMember.roles, existing?.rankKey, !!existing?.isOwner && !owner);
    // nouveau propriétaire : l'ancien perd aussitôt ce que la propriété lui donnait, sans attendre sa reconnexion
    if (owner) await retirerProprietaires(user.id);
    const m = await prisma.member.upsert({
      where: { discordId: user.id },
      create: {
        discordId: user.id, username: user.username, avatar: user.avatar,
        displayName: guildMember.nick || user.global_name || user.username,
        rankKey: rankFromRole ?? startRank ?? null, isOwner: owner, memberRole, leftGuildAt: null,
        status: owner ? 'approved' : 'pending', approvedAt: owner ? new Date() : null, lastLogin: new Date(),
      },
      update: {
        username: user.username, avatar: user.avatar, isOwner: owner, memberRole, leftGuildAt: null, lastLogin: new Date(),
        rankKey: gradeRelu ?? (owner ? startRank ?? null : null),
        ...(owner && { status: 'approved' as const }),
      },
    });

    await openSession(req, m.id);
    revaliderFluxPlusTard();   // grade ou rôle membre relus : ses onglets du chat déjà ouverts suivent
    res.redirect(m.status === 'approved' ? '/espace/profil.html' : '/espace/attente.html');
  } catch (e) {
    console.error(e);
    res.redirect('/espace/?error=server');
  }
});

auth.post('/auth/logout', (req, res) => {
  // les autres onglets de la session (chat) se ferment, et ce que le site gardait pour le bot est oublié
  fermerSession(req.sessionID);
  if (req.session.memberId) oublierBot(req.session.memberId);
  req.session.destroy(() => res.clearCookie('site.sid').json({ ok: true }));
});
