# Contexte projet — Modèle de site de famille RP (Roxwood Network)

Notes de conventions et de pièges pour un agent Claude Code travaillant sur ce dépôt **ou sur un site créé à partir de lui** (bouton « Use this template »). Le modèle vient du site de La Maja 13, rendu générique.

- **Toujours répondre en français à l'utilisateur.** Tout le site, les messages d'erreur, les commentaires du code et les commits sont en français.
- Style du code : dense, commentaires courts qui disent *pourquoi*, pas de framework front (HTML / CSS / JS natif), TypeScript côté serveur. Imiter le code voisin.

## La règle qui structure tout : personnalisable / mutualisé

| Personnalisable par site | Mutualisé (identique partout) |
|---|---|
| `site.json`, `theme.css`, `index.html`, `styles.css`, `assets/`, `pellicule.js` | `espace/` (pages, `espace.js`, `espace.css`), `server/`, `org.js`, `main.js`, `404.html`, `compose*.yaml`, `docs/`, `.claude/skills/` |

- La **vitrine** et la **direction artistique** sont libres dans chaque site.
- La **partie gestion** (espace membre + serveur) ne se modifie **pas** dans un site : on corrige dans le modèle, puis chaque site fait `git fetch modele && git merge modele/main` (voir README). Un site qui modifie un fichier mutualisé se crée des conflits à chaque mise à jour.
- Reporter le modèle dans un site **uniquement par ce merge**, jamais en recopiant les fichiers ni par `git cherry-pick` : git ne saurait pas que ces commits sont intégrés, et chaque merge suivant signalerait des conflits partout. Historique déjà divergé alors que le contenu est identique (vérifier `git diff HEAD modele/main -- espace server docs`, vide hors valeurs propres au site) : `git merge -s ours modele/main` l'enregistre une fois sans changer aucun fichier.
- La DA **s'applique** à la partie gestion sans la modifier (y compris le bord perforé du rail : `--rail-perforations` et voisines dans `theme.css`, voir l'en-tête de `espace.css` ; jamais en surchargeant des sélecteurs de l'espace dans `styles.css`) : l'espace membre ne contient aucune couleur de marque ni police en dur, tout passe par les variables de `theme.css` (`--bg`, `--ink`, `--accent`, `--display`…, et `--on-accent` pour le texte posé sur l'accent, blanc à défaut). Seules les couleurs d'état (succès, alerte, erreur) et les séries des graphiques (`--viz-*`) sont fixes, déclarées une fois en tête de `espace.css` : une page ou un script les lit (`var(--viz-1)`, `espaceCouleurs()`), sans jamais réécrire un code couleur.
- Dans le dépôt **modèle** : ne jamais réintroduire de contenu propre à un groupe (noms, lieux, termes espagnols « familia », « casa », etc.). Les textes de l'espace membre sont neutres ; le nom et le vocabulaire du groupe viennent de `site.json`.

## Identité du site : `site.json` et `server/src/site.ts`

- `site.json` (racine) : `nom`, `espace`, `groupe`, `devise`, `serveur`, `couleur` (facultative, `#rrggbb`), `discord`, `description`. Le serveur refuse de démarrer si une clé obligatoire manque ou si `couleur` n'est pas un hexadécimal.
- `site.ts` remplace `{{cle}}` au moment de servir les fichiers `.html`, `.css`, `.txt`, `.xml` (vitrine, `espace/`, `robots.txt`, `sitemap.xml`, `theme.css`). `{{Cle}}` = même valeur avec majuscule initiale. `{{url}}` = `BASE_URL` (le domaine n'est écrit nulle part en dur). Les valeurs sont échappées pour le HTML. Rendu mis en cache en production, relu à chaque requête en dev.
- **Piège** : ne jamais placer un `{{…}}` dans une **chaîne JavaScript** d'un `<script>` en ligne. Une valeur contenant une apostrophe (« l'organisation ») casserait le script. En JS, lire le nom du site via `SITE_NAME` / `SITE_NAME_HTML` (`espace.js`, tiré de `<meta name="application-name" content="{{nom}}">`), ou tourner la phrase sans le nom.
- Chaque nouvelle page de `espace/` doit reprendre l'en-tête des autres : `<meta name="application-name" content="{{nom}}">`, `../theme.css` **avant** `../styles.css` puis `espace.css`, la barre de navigation commune, `espace.js`.

## Stack et commandes

- Serveur : Node 22, Express 5, TypeScript (ESM), Prisma 7 + PostgreSQL 17, sessions `connect-pg-simple`, `helmet`, `express-rate-limit`.
- Dev (Docker Desktop) : `docker compose up` → http://localhost:3000. `compose.override.yaml` monte le code, lance `tsx`, active `DEV_LOGIN` (connexion sans Discord : `/auth/discord` ouvre le compte « Dev local », `/auth/discord?compte=<ID Discord>` un compte existant, pour essayer chaque niveau d'accès). Après modification de `server/src` : `docker compose restart app`.
- Vérifier le typage : `docker exec -w /app/server <SITE_ID ou site>-app npx tsc -p . --noEmit` (sous Git Bash Windows, préfixer `MSYS_NO_PATHCONV=1`).
- Migration : modifier `server/prisma/schema.prisma`, puis `docker compose exec app npx prisma migrate dev --name <description>` et **committer le dossier créé** (la prod applique les migrations au démarrage, `prisma migrate deploy`). Une migration ne s'annule pas : retour arrière = restauration d'une sauvegarde.
- Prod : voir `server/README.md` (VPS, nginx, certbot, `.env` avec `COMPOSE_FILE=compose.yaml` qui écarte l'override de dev).

## Espace membre (mutualisé)

- Pages dans `espace/` : `index` (connexion), `attente`, `profil` ; pour le rôle membre : `chat` (flux SSE), `classement`, `taxes`, `armurerie` ; sous « Gestion » : `tableau`, `stats`, `garages`, `admin` (pouvoirs complets), `membres`, `organigramme` (pouvoirs complets) ; `bot-callback` pour la liaison au bot. Le menu (`ESPACE_NAV`, `espace.js`) porte le niveau de chaque rubrique (`acces`).
- Pages de `espace/` : servies seulement à qui y a droit (`NIVEAU_PAGE`, `server/src/index.ts`, mêmes règles que l'API), sinon `refuse.html` (403), la connexion ou l'attente. Une nouvelle page s'y déclare avec son niveau.
- Accès : compte validé = son profil seul ; **rôle membre** = rôle Discord dont l'identifiant se règle dans Gestion → Hiérarchie (table `settings`), relu à chaque connexion et, avec `DISCORD_BOT_TOKEN`, toutes les 10 minutes avec les grades (`synchro-discord.ts`, mêmes règles que la connexion : `grade-connexion.ts`, testé ; un membre parti du serveur est déconnecté et marqué `leftGuildAt`) (`memberRole` : l'identifiant porté, comparé au réglage actuel, si bien que changer le rôle retire aussitôt l'accès à qui n'avait que l'ancien), implicite pour la Gestion, et personne ne l'a tant qu'il n'est pas réglé (`canMember`, `ranks.ts`) ; puis grades Gestion (`canAdmin`) / Pouvoirs complets (`canManage`). Le **propriétaire du serveur Discord** a toujours tout (`isOwner`, revérifié à chaque connexion ; quand un nouveau propriétaire se connecte, l'ancien perd ses pouvoirs et son grade sans rôle Discord). Gardes serveur : `approved`, `member`, `admin`, `manager` dans `server/src/http.ts` ; toute route ajoutée en utilise une. Le bot applique en plus ses propres règles (son rôle membre et son rôle admin).
- Grade à la connexion (`routes/auth.ts`) : le plus haut grade dont le rôle Discord est porté ; un grade lié à un rôle que le membre ne porte plus est retiré ; un grade attribué à la main (sans rôle Discord) plus haut que celui du rôle l'emporte, sinon lier un grade inférieur à un rôle porté par tous ferait tomber les supérieurs.
- Détail des routes, droits et limites de requêtes : `docs/api.md`.

## Bot Discord Roxwood (API relayée)

- Code : `server/src/routes/bot.ts`. Le site relaie **en lecture seule** l'API REST du bot ([roxwood-network-famille](https://github.com/poulpizar01/roxwood-network-famille)) : `/api/bot/data/<rubrique>/…` → `<BOT_API_URL>/api/<rubrique>/…` avec le jeton personnel du membre (gardé en session, jamais renvoyé au navigateur). Rubriques autorisées : `me`, `users`, `stocks`, `quotas`, `taxes`, `armurerie`, `ventes`, `garages`, `roles` (rôles du serveur Discord, pour choisir un rôle par son nom dans Hiérarchie).
- Le bot limite **tout le site** à 300 requêtes par quart d'heure : cache mémoire par membre (5 min, jusqu'à 24 h pour `?week=` passé, plafonné en taille), limite de `BOT_BUDGET` / 2 lectures par membre (120 par défaut), part réservée aux autres aux trois quarts de `BOT_BUDGET` (ceux qui en ont fait le quart attendent), plafond dur à `BOT_BUDGET` appels (240 par défaut), compte recalé sur les en-têtes `RateLimit-*` du bot (un redémarrage du site ne le remet pas à zéro), pause complète après un `429` du bot. Toute nouvelle page qui lit le bot passe par `espaceBot.get()`, se rafraîchit par `espaceBot.every()` (5 minutes, onglet visible seulement), lit ses référentiels par `espaceBot.une()` (une fois par visite) et ne lit à l'arrivée que ce qu'elle affiche d'emblée. Exception assumée : Statistiques ne se rafraîchit pas (et ne relit rien en redimensionnant après un échec). La limite du bot est par serveur Discord : des sites sur un même VPS ne se la partagent pas.
- Un serveur Discord n'a **qu'un seul site externe** déclaré (`/config site-externe set`) : tester le bot en dev sur un serveur Discord de test.
- Quand le bot change son API, vérifier la compatibilité : cloner son dépôt, comparer `src/api/` aux adresses appelées par `espace/*.html` et aux champs lus (voir le tableau des rubriques dans `docs/api.md`).

## Mémoire et fichiers

- **Aucun envoi d'images** sur les sites de famille (galerie retirée en octobre 2026) : pas de route d'envoi, pas de stockage de fichiers, rien n'est écrit sur le disque, tout est en base. Ne pas en réintroduire sans décision explicite (le modèle entreprise, lui, en a).
- Plafonds Docker par défaut : site 512 Mo (Node : 320 Mo de tas, `NODE_OPTIONS`), base 256 Mo, sauvegardes 128 Mo — réglables dans `.env`.
- `assets/exemples/` : images de la vitrine à remplacer par celles du groupe (fichiers du projet).

## Sécurité (à préserver)

- `helmet` avec une CSP stricte (`server/src/security.ts`) : scripts, styles et polices depuis le site uniquement (aucun hébergeur tiers), **scripts en ligne seulement avec le jeton (nonce) de la réponse**, que `site.ts` ajoute à chaque `<script>` des pages servies — un `<script>` écrit dans une page fonctionne donc tel quel, mais un attribut `onclick=…` ou un script inséré par `innerHTML` ne s'exécute jamais (écouteurs en JS uniquement) ; images depuis le site et Discord (avatars). Une bibliothèque ou une police se copie dans le dépôt (`assets/`, `espace/vendor/`) plutôt que de se charger d'ailleurs.
- Requêtes qui modifient des données : refusées si l'en-tête `Origin` n'est pas celui de `BASE_URL` (un site voisin sur le même domaine ne peut pas agir au nom d'un membre).
- Réponses de `/api` et `/auth` : `Cache-Control: no-store` (détail des taxes, paies : rien ne reste dans le cache d'un ordinateur partagé).
- Seuls `espace/`, `assets/` et les fichiers de premier niveau (`*.html|css|js|txt|xml`) sont servis : jamais `server/`, `site.json`, `compose.yaml`, `.env`. Vérifier avec `curl` qu'un nouveau fichier sensible reste en 404.
- Sessions : cookie `site.sid` `HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS, 7 jours ; nouvelle session à chaque connexion. Le middleware de session ne tourne que sur `/api`, `/auth` et les pages HTML de `/espace/` (jamais sur les css, js et images), sans écriture en base à chaque requête (`disableTouch`) : une route qui lit `req.session` doit vivre sous `/api` ou `/auth` — seule exception, le contrôle d'accès des pages de `/espace/` (`server/src/index.ts`).
- Connexion de dev (`DEV_LOGIN=1`) : trois verrous indépendants, à garder tous — refusée si `BASE_URL` n'est pas `http://localhost`, refusée dans l'image de production (`NODE_ENV=production`), et la route n'accepte qu'une requête arrivée directement sur la machine (Host `localhost`, sans en-tête `X-Forwarded-*` d'un proxy).

## Déploiement : pièges connus

- Guide complet : `server/README.md` (installation, première connexion, mises à jour, sauvegardes, retour arrière). Ordre de mise en service : bot à jour et `/config role set membre`, puis le site, puis le rôle membre dans Gestion → Hiérarchie, puis chaque membre se reconnecte.
- `config.ts` refuse de démarrer sur un `.env` incomplet ou douteux (secret de session de moins de 32 caractères, adresses invalides) : vérifier le `.env` de prod avant une mise à jour qui touche `config.ts`.
- Base : en prod, le site se connecte avec `site_app` (propriétaire des tables, pas super-utilisateur), créé par le service `db-roles` ; en dev il garde `site` (`prisma migrate dev` crée une base temporaire). Une migration qui exige un super-utilisateur (`CREATE EXTENSION`…) passerait en dev et échouerait en prod. Restaurer une sauvegarde avec `psql -U site_app`.
- Sauvegardes : sans les sessions (jetons du bot), fichiers en `600`. Ne stocker aucun secret en base hors de la table `session` sans l'exclure aussi de `pg_dump` (`compose.yaml`).
- Aucune ressource tierce dans les pages (polices dans `assets/fonts/`, bibliothèques dans `assets/vendor/` ou `espace/vendor/`) : la page `confidentialite.html` l'affirme, la garder vraie.
- `SITE_ID` et `HOST_PORT` uniques par VPS (conteneurs `<SITE_ID>-app/-db/-backup` et `-db-roles`, qui ne tourne qu'au démarrage ; volumes préfixés).
- Ne pas tester la connexion avant le certificat : cookie `Secure` → la connexion échoue en `http://`.
- Règles de l'hébergement (VPS) : aucun volume Docker de médias ; un fichier nginx par site nommé `<domaine>.conf`, avec un bloc HTTP réservé au défi ACME (certificat), `include snippets/deny-hidden.conf`, `X-Forwarded-Proto` et `X-Forwarded-Host` transmis, et le bloc `location = /api/chat/stream` (SSE) gardé. Modèle : `server/deploy/nginx.conf.example`, ordre de mise en place : `docs/nginx.md`.
- Ne jamais copier `.env.example` en dev (sa ligne `COMPOSE_FILE` désactive l'override de dev).
- En dev, les `assets/` ne sont pas mis en cache (`maxAge` 0) ; en prod, 7 jours : un visuel remplacé peut rester en cache chez les visiteurs.

## Vérifier un changement visuel

Le site doit rester propre de 360 px à l'écran large : aucun débordement horizontal, menu utilisable à toutes les largeurs où son bouton s'affiche (toujours dans une vitrine qui porte la classe `vitrine`, sous 1 180 px sinon), hero empilé sous 1 000 px. Après un changement de mise en page, contrôler au minimum 375, 768, 1 024 et 1 280 px (vitrine, profil, admin, chat), menu burger ouvert compris.

## Audits

`/audit [angle]` (`.claude/skills/audit/`) lance les prompts de `docs/audits.md` : accès et sessions, navigateur, relais du bot, fiabilité, modèle mutualisé — chacun dans un agent séparé, puis un rapport fusionné. À lancer avant une mise en prod ou après une grosse fonctionnalité. `docs/audits.md` reste la seule source des prompts. Dans un site créé depuis le modèle, un défaut trouvé dans un fichier mutualisé se corrige **dans le modèle**.

## Git

- Commits en français, préfixés par le domaine (`Espace membre : …`, `Vitrine : …`, `Docker : …`, `Docs : …`), corps expliquant le pourquoi.
- Ne pas committer : `.env`, `backups/`, `node_modules/`, `server/src/generated/`, `server/dist/` (déjà ignorés).
