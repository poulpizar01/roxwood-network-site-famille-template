/* Serveur du site : vitrine + espace membre.
   Express + PostgreSQL (Prisma) + Discord OAuth2. Les routes sont rangées par domaine dans routes/. */
import { join, posix } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import session from 'express-session';
import connectPg from 'connect-pg-simple';
import { config } from './config.js';
import { pool, prisma } from './db.js';
import { planifierPurge } from './purge.js';
import { planifierSynchroDiscord } from './synchro-discord.js';
import { loadRanks } from './ranks.js';
import { loadSettings } from './settings.js';
import { cspNonce, limits, securityHeaders } from './security.js';
import { site, pages, renderFile, withNonce } from './site.js';
import { canAdmin, canManage, canMember } from './ranks.js';
import { auth } from './routes/auth.js';
import { members } from './routes/members.js';
import { hierarchy } from './routes/hierarchy.js';
import { chat, fermerTousLesFlux } from './routes/chat.js';
import { bot } from './routes/bot.js';

await Promise.all([loadRanks(), loadSettings()]);
planifierPurge();
planifierSynchroDiscord();

const app = express();
app.set('trust proxy', 1);                     // derrière nginx (adresse IP réelle pour les limites de requêtes)
app.use(cspNonce, securityHeaders);
app.use(express.json({ limit: '32kb' }));

// santé du site (contrôle Docker) : le serveur répond et la base aussi ; hors limites de requêtes et sans session
app.get('/healthz', async (_req, res) => {
  try { await pool.query('select 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

// Session : seulement pour l'API, la connexion et l'accueil de l'espace membre — jamais pour les fichiers du site
// (css, js, images), qui sans ça coûteraient chacun une lecture en base. disableTouch : pas d'écriture en base à
// chaque requête (la session expire à date fixe). 7 jours : la connexion Discord, qui revérifie l'appartenance au
// serveur, le grade et la propriété, a lieu au moins chaque semaine (même rythme que la connexion au bot).
const sessions = session({
  store: new (connectPg(session))({ pool, tableName: 'session', disableTouch: true }),
  name: 'site.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https'), maxAge: 7 * 24 * 3600 * 1000 },
});
app.use(['/api', '/auth'], sessions);
// Réponses propres à un membre (détail d'une taxe avec téléphone et mot de passe, paies…) : jamais gardées par le
// navigateur, qui les laisserait lisibles sur un ordinateur partagé après la déconnexion
app.use(['/api', '/auth'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Requêtes qui modifient quelque chose : acceptées seulement depuis les pages du site. Le cookie SameSite=Lax arrête
// les autres sites, pas un voisin du même domaine (a.exemple.fr → b.exemple.fr), qui pourrait sinon écrire dans le
// chat au nom d'un membre. Le navigateur joint toujours l'en-tête Origin à ces requêtes ; absent (curl, script), rien à craindre.
const origine = new URL(config.baseUrl).origin;
app.use(['/api', '/auth'], (req, res, next) => {
  const recue = req.get('origin');
  if (req.method === 'GET' || req.method === 'HEAD' || !recue || recue === origine) next();
  else res.status(403).json({ error: 'origine refusée' });
});

app.use('/auth', limits.auth);
app.use('/api', limits.api);
app.use(auth, members, hierarchy, chat, bot);

// ---------- site statique : uniquement ce qui est public ----------
// espace/ et assets/, plus les fichiers de la racine du site (pages, css, js, robots.txt, sitemap.xml) ;
// jamais le reste du dépôt (code du serveur, compose.yaml, README…), quelle que soit l'écriture de l'adresse.
// Les pages (.html, .txt, .xml) passent par site.ts, qui y insère l'identité du site (site.json).
// redirect: false — un dossier du dépôt (/server, /docs) répond 404 comme le reste, sans révéler qu'il existe
const statics: Parameters<typeof express.static>[1] = { index: false, dotfiles: 'ignore', redirect: false };
// session déjà ouverte : /espace/ mène droit au profil (ou à l'attente), sans afficher la page de connexion
// (elle garde la même redirection en JavaScript, en repli)
app.get(['/espace', '/espace/', '/espace/index.html'], sessions, async (req, res, next) => {
  if (!req.session.memberId) return next();
  const m = await prisma.member.findUnique({ where: { id: req.session.memberId }, select: { status: true } });
  if (!m) return next();
  res.redirect(m.status === 'approved' ? '/espace/profil.html' : '/espace/attente.html');
});
// Pages de l'espace membre : envoyées seulement à qui y a droit, selon les mêmes règles que l'API (http.ts). Sinon, la
// page n'est jamais envoyée : pas connecté → connexion ; compte pas encore validé → attente ; droits insuffisants →
// « accès refusé » (403). Une lecture de session et de compte par page ouverte, jamais pour les css, js et images.
const NIVEAU_PAGE: Record<string, 'connecte' | 'valide' | 'membre' | 'gestion' | 'complet'> = {
  attente: 'connecte', profil: 'valide',
  chat: 'membre', classement: 'membre', taxes: 'membre', armurerie: 'membre',
  tableau: 'gestion', stats: 'gestion', garages: 'gestion', membres: 'gestion',
  admin: 'complet', organigramme: 'complet',
};
// La page est déduite du chemin tel que le serveur de fichiers le lira : décodé, normalisé, sans casse (adm%69n.html,
// //admin.html, Admin.html sur un disque Windows désignent tous admin.html).
const pageDemandee = (chemin: string): string | null => {
  try { chemin = decodeURIComponent(chemin); } catch { return null; }
  const nom = posix.basename(posix.normalize(chemin)).toLowerCase();
  return /^[\w-]+(\.html)?$/.test(nom) ? nom.replace(/\.html$/, '') : null;
};
app.use('/espace', (req, res, next) => {
  const niveau = req.method === 'GET' || req.method === 'HEAD' ? NIVEAU_PAGE[pageDemandee(req.path) ?? ''] : undefined;
  if (!niveau) return next();
  sessions(req, res, () => { accesPage(req, res, next, niveau).catch(next); });
});
async function accesPage(req: express.Request, res: express.Response, next: express.NextFunction, niveau: string) {
  const m = req.session.memberId ? await prisma.member.findUnique({ where: { id: req.session.memberId } }) : null;
  if (!m) return res.redirect('/espace/');
  if (niveau !== 'connecte' && m.status !== 'approved') return res.redirect('/espace/attente.html');
  const permis = niveau === 'connecte' || niveau === 'valide' || (niveau === 'membre' && canMember(m)) || (niveau === 'gestion' && canAdmin(m)) || (niveau === 'complet' && canManage(m));
  if (permis) return next();
  res.status(403).type('html').send(withNonce(renderFile(join(config.root, 'espace', 'refuse.html')), res));
}
app.use('/espace', pages(join(config.root, 'espace')), express.static(join(config.root, 'espace'), statics));
// images gardées 7 jours par les navigateurs en production ; en dev, toujours revalidées (un visuel changé s'affiche aussitôt)
app.use('/assets', express.static(join(config.root, 'assets'), { dotfiles: 'ignore', maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0 }));
const rootPages = pages(config.root), rootFiles = express.static(config.root, statics);
app.use((req, res, next) => {
  if (!/^\/([\w-]+(\.(html|css|js|txt|xml))?)?$/.test(req.path)) return next();
  rootPages(req, res, () => rootFiles(req, res, next));
});
app.use((_req, res) => {
  try { res.status(404).type('html').send(withNonce(renderFile(join(config.root, '404.html')), res)); } catch { res.status(404).send('404'); }
});

// erreur imprévue dans une route : journalisée, réponse générique
// Corps JSON illisible : 400, sans le journaliser (il peut contenir un jeton). Ailleurs, seuls le message et la pile.
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if ((err as { type?: string }).type === 'entity.parse.failed') { if (!res.headersSent) res.status(400).json({ error: 'requête illisible' }); return; }
  console.error((err as Error).stack || (err as Error).message || 'erreur inconnue');
  if (!res.headersSent) res.status(500).json({ error: 'erreur serveur' });
};
app.use(onError);

const serveur = app.listen(config.port, '0.0.0.0', () => console.log(`${site.nom} en écoute sur le port ${config.port} (${config.baseUrl})`));

// Arrêt demandé par Docker (mise à jour, redémarrage) : plus de nouvelle requête, celles en cours se terminent, puis la base est rendue. Après 8 s, on sort quand même (Docker coupe à 10).
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  fermerTousLesFlux();
  serveur.close(() => { pool.end().catch(() => {}).finally(() => process.exit(0)); });
  serveur.closeIdleConnections();
  setTimeout(() => process.exit(0), 8000).unref();
});
