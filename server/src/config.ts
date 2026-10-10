// Configuration lue dans l'environnement (.env en prod, compose.override.yaml en dev).
// Une valeur vide (« NOM= », comme dans .env.example) compte comme absente : le serveur s'arrête ici avec un message
// clair, plutôt que de démarrer et d'échouer à la première requête.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const env = process.env;
// adresse http(s) valide, sans slash final (collé à un chemin, il donnerait « //… ») ; vide si absente
function adresse(name: string): string {
  const v = (env[name] || '').trim();
  if (!v) return '';
  let u: URL;
  try { u = new URL(v); } catch { fail(`${name} dans .env n'est pas une adresse valide : ${v}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`${name} dans .env doit commencer par http:// ou https:// : ${v}`);
  return v.replace(/\/+$/, '');
}

const baseUrl = adresse('BASE_URL') || fail('Variable manquante dans .env : BASE_URL');

// connexion de dev sans Discord : uniquement en local (DEV_LOGIN=1 + BASE_URL sur localhost), jamais dans l'image de
// production (NODE_ENV=production, server/Dockerfile ; le dev passe en development, compose.override.yaml). Deux verrous
// indépendants : un .env de prod mal rempli ne suffit pas à l'ouvrir. Le troisième est dans la route (routes/auth.ts).
const devLogin = env.DEV_LOGIN === '1';
if (devLogin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) fail('DEV_LOGIN=1 refusé : BASE_URL doit être http://localhost');
if (devLogin && env.NODE_ENV === 'production') fail('DEV_LOGIN=1 refusé : connexion de dev impossible dans l’image de production (NODE_ENV=production)');

const required = (name: string): string => env[name] || (devLogin ? '' : fail(`Variable manquante dans .env : ${name}`));

// le secret signe les cookies de session : un secret court se devine (en dev, la valeur fixe de compose.override.yaml suffit)
const sessionSecret = env.SESSION_SECRET || fail('Variable manquante dans .env : SESSION_SECRET');
if (!devLogin && sessionSecret.length < 32) fail('SESSION_SECRET trop court dans .env (32 caractères au moins) : openssl rand -hex 32');

// racine du dépôt (index.html, styles.css, espace/…) : dist/ ou src/ → server/ → racine
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const config = {
  port: Number(env.PORT) || 3000,
  baseUrl,
  devLogin,
  // compte de dev : ID Discord réel (DEV_DISCORD_ID) pour pouvoir le connecter au bot, sinon un identifiant fictif
  devDiscordId: env.DEV_DISCORD_ID || 'dev-local',
  sessionSecret,
  discord: {
    clientId: required('DISCORD_CLIENT_ID'),
    clientSecret: required('DISCORD_CLIENT_SECRET'),
    guildId: required('DISCORD_GUILD_ID'),
    // jeton d'un bot présent sur le serveur (aucune permission) : rôles relus toutes les 10 minutes ; vide = à la connexion seulement
    botToken: (env.DISCORD_BOT_TOKEN || '').trim(),
  },
  root,
  // API REST du bot Discord (géré à part) ; vide = pages liées au bot désactivées
  botApiUrl: adresse('BOT_API_URL'),
  // Plafond d'appels au bot par quart d'heure, sous les 300 que le bot accorde à chaque serveur Discord (routes/bot.ts).
  // 30 au moins.
  botBudget: Math.max(30, Math.min(300, Number(env.BOT_BUDGET) || 240)),
};
