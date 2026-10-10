# Serveur et déploiement

Express + PostgreSQL + Discord OAuth. Sert aussi le site vitrine (racine du dépôt). Pour créer un site à partir du modèle et pour le développement, voir le [README de la racine](../README.md).

Documentation détaillée : [nginx](../docs/nginx.md) · [API du site et du bot](../docs/api.md).

## Production
Tout tourne dans Docker, avec le même [`compose.yaml`](../compose.yaml) qu'en dev (site + base + sauvegardes). Le site n'écoute que sur `127.0.0.1:<HOST_PORT>` ; **nginx**, sur la machine, l'expose en HTTPS.

Les commandes ci-dessous visent un VPS Debian / Ubuntu, avec un utilisateur qui a `sudo`. `<depot>` est l'adresse du dépôt **du site** (pas celle du modèle), `<SITE_ID>` l'identifiant choisi dans `.env`.

### 1. Avant de commencer
- **Domaine** : un enregistrement DNS `A` (et `AAAA` si le VPS a une IPv6) du domaine vers l'IP du VPS. Vérifier avec `dig +short <domaine>` : certbot échoue tant que le domaine ne pointe pas sur la machine.
- **Application Discord** : créée et configurée (voir [Application Discord](#application-discord)), avec la redirection `https://<domaine>/auth/discord/callback`.
- **Bot Discord** (facultatif) : l'URL publique HTTPS de son API, et un bot **à jour** (rôle membre et route `/api/roles`, voir [Bot Discord](#bot-discord)).

### 2. Préparer le VPS (une seule fois par machine)
```bash
# Docker (script officiel : Docker Engine + docker compose), démarré avec la machine
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER            # puis se déconnecter / reconnecter pour utiliser docker sans sudo
# nginx, certbot, git
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx git
# pare-feu : SSH + web (si ufw est utilisé ; sinon, ouvrir 80 et 443 dans le pare-feu de l'hébergeur)
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

### 3. Installer le site
```bash
git clone -b main <depot> <SITE_ID> && cd <SITE_ID>
cp .env.example .env && chmod 600 .env
mkdir -m 700 backups                        # sauvegardes de la base : lisibles par vous seul
nano .env                                   # remplir : tout est expliqué dans le fichier
docker compose up -d --build
```
- Le serveur suit la branche `main` : c'est elle qui est déployée.
- `SITE_ID` et `HOST_PORT` doivent être **uniques sur la machine** : chaque site a ses propres conteneurs (`<SITE_ID>-app`, `<SITE_ID>-db`, `<SITE_ID>-backup`, et `<SITE_ID>-db-roles`, qui ne tourne qu'un instant à chaque démarrage) et son propre port. `ss -ltnp` liste les ports déjà pris (autres sites, API du bot…).
- Générer `SESSION_SECRET` (32 caractères au moins, sinon le site refuse de démarrer) et `POSTGRES_PASSWORD` avec `openssl rand -hex 32` (le mot de passe de la base ne se change plus une fois la base créée).

Vérifier : `docker compose ps` (les trois services `Up`, la base `healthy` ; `db-roles`, qui prépare le compte de base du site puis s'arrête, n'y figure pas) et `docker logs <SITE_ID>-app`, qui doit finir par `<nom du site> en écoute sur le port 3000 (https://<domaine>)`. Le premier démarrage crée les tables (migrations Prisma).

### 4. nginx et HTTPS
Un fichier `/etc/nginx/sites-available/<domaine>.conf` tiré de [`server/deploy/nginx.conf.example`](deploy/nginx.conf.example) : un bloc HTTP réservé au défi ACME (certificat) et un bloc HTTPS pour le site. Au premier déploiement, le bloc HTTPS n'est ajouté qu'une fois le certificat obtenu (`certbot certonly --webroot`) : commandes dans l'ordre dans [docs/nginx.md](../docs/nginx.md#mise-en-place).

**Ne pas tester la connexion avant le certificat** : avec `BASE_URL` en `https://`, le cookie de session n'est envoyé qu'en HTTPS, la connexion Discord échoue donc en `http://`. Rôle de chaque réglage nginx, plusieurs sites, dépannage : [docs/nginx.md](../docs/nginx.md).

### 5. Première connexion
La base de prod démarre **vide** (rien n'est repris du dev). Dans cet ordre :
1. **Bot** (s'il est utilisé) : déclarer le site externe et le rôle membre du bot (`/config site-externe set …`, `/config role set membre @Rôle`, voir [Bot Discord](#bot-discord)).
2. Le **propriétaire du serveur Discord** se connecte le premier au site : il est validé d'office avec tous les droits. Il relie son compte au bot (bouton « Connecter mon compte au bot », page Mon profil), puis, dans l'espace membre → Gestion → Hiérarchie :
   - choisit le **rôle Discord membre** (dans la liste des rôles du serveur quand son compte est relié au bot ; sinon, coller l'identifiant du rôle). Sans ce réglage, seule la Gestion a accès au-delà du profil ;
   - crée les grades (nom, ordre, couleur, droits, rôle Discord lié éventuel).
3. Les autres membres se connectent : leur demande attend la validation (Gestion → Administration, réservée aux pouvoirs complets), puis ils ont accès à l'espace s'ils portent le rôle membre.

Niveaux d'accès et pages de chacun : [docs/api.md](../docs/api.md#niveaux-daccès).

Le domaine n'est écrit nulle part dans les fichiers : `robots.txt`, `sitemap.xml` et les aperçus de partage le prennent dans `BASE_URL`.

### Au quotidien (dans le dossier du site)
- Mise à jour après un push sur `main` : `git pull && docker compose up -d --build` (les nouvelles migrations sont appliquées au démarrage), puis `docker image prune -f` pour effacer les anciennes images.
- Changer la configuration : modifier `.env`, puis `docker compose up -d`
- Logs : `docker logs -f <SITE_ID>-app` (limités à 3 × 10 Mo par service, voir `compose.yaml`)
- Mémoire et processeur : chaque conteneur a un plafond (site 512 Mo et 1 processeur, base 256 Mo et 1 processeur, sauvegardes 128 Mo). `docker stats` montre la consommation réelle ; pour les ajuster, décommenter `APP_MEMORY`, `DB_MEMORY`… dans `.env`, puis `docker compose up -d`.
- État : `docker compose ps` — le site y apparaît `healthy` quand il répond et joint la base (contrôle toutes les 30 s sur `/healthz`). S'il reste `unhealthy`, le redémarrer : `docker compose restart app` (Docker redémarre seul un conteneur arrêté, pas un conteneur malade).

Le `.env` contient `COMPOSE_FILE=compose.yaml` : les commandes ci-dessus ignorent ainsi les réglages de dev (`compose.override.yaml`).

### Revenir en arrière après une mise à jour ratée
Les migrations de la base ne s'annulent pas : revenir à un ancien commit ne suffit pas si la mise à jour en contenait une.
1. Revenir au code précédent : `git log --oneline`, puis `git checkout <commit>` et `docker compose up -d --build`.
2. Si la mise à jour contenait une migration (`server/prisma/migrations/`) : restaurer la dernière sauvegarde **antérieure** à la mise à jour (voir ci-dessous). Les écritures faites entre-temps sont perdues.
3. Une fois le problème corrigé sur `main` : `git checkout main && git pull && docker compose up -d --build`.

Faire une sauvegarde juste avant une mise à jour qui touche la base : `docker compose restart backup`.

### Sauvegardes de la base
Le service `backup` (dans `compose.yaml`) sauvegarde la base au démarrage puis toutes les 24 h, dans le dossier `backups/` du site sur la machine (7 jours conservés). C'est un dossier et non un volume Docker : il survit à un `docker compose down -v`. Les photos de la galerie n'y sont pas (elles sont sur le stockage d'images), les sessions non plus (elles portent les jetons personnels du bot) : après une restauration, chacun se reconnecte.

Une sauvegarde contient tout le chat et les identifiants Discord des membres : les fichiers ne sont lisibles que par le propriétaire du dossier `backups/`. Le dossier est créé à l'installation (`mkdir -m 700 backups`) : s'il a été créé par Docker, il appartient à root ; le rendre : `sudo chown -R $USER: backups && chmod 700 backups`.
- Sauvegarde immédiate : `docker compose restart backup`
- Restaurer (remplace le contenu actuel de la base) :
  ```bash
  docker compose stop app
  # 1. base vidée : une sauvegarde ne retire que ce qu'elle contient. Sans cette étape, une table créée depuis (par une
  #    migration, lors d'une mise à jour ratée) resterait en place et bloquerait le démarrage suivant (« already exists »).
  docker exec <SITE_ID>-db psql -U site -d site -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public AUTHORIZATION site_app'
  # 2. restauration, en une seule transaction : à la première erreur, rien n'est écrit (pas de base à moitié restaurée)
  gunzip -c backups/site-AAAA-MM-JJ_HHhMM.sql.gz | docker exec -i <SITE_ID>-db psql -U site_app -d site -v ON_ERROR_STOP=1 --single-transaction
  docker compose start app
  ```
  `-U site_app` et non `-U site` pour la restauration : les tables recréées doivent appartenir au compte du site. Restaurées par erreur avec `site`, le site ne peut plus les lire ; `docker compose up -d` (qui relance `db-roles`) les lui rend. Une sauvegarde en échec n'écrit aucun fichier et le dit dans `docker logs <SITE_ID>-backup` ; les copies précédentes sont alors gardées au-delà de 7 jours.
- Ces copies restent sur la même machine : elles protègent des erreurs de manipulation, **pas de la perte du serveur**. Il faut en garder une copie ailleurs, par exemple sur un stockage objet (S3, Backblaze B2, Scaleway…) avec [rclone](https://rclone.org), une fois `rclone config` fait (remote nommé `sauvegardes`). **Chiffrer cette copie** : dans `rclone config`, créer le remote `sauvegardes` de type `crypt` par-dessus le remote du stockage objet, et garder son mot de passe ailleurs que sur le VPS (sans lui, les copies sont illisibles, pour vous aussi) :
  ```bash
  # crontab -e : chaque nuit à 4 h, copie des sauvegardes du site hors du serveur (copy : n'efface rien là-bas)
  0 4 * * * rclone copy ~/<dossier-du-site>/backups sauvegardes:<SITE_ID>/ --max-age 48h >> ~/rclone-<SITE_ID>.log 2>&1
  ```
  Côté stockage objet, une règle de cycle de vie (suppression après 30 jours, par exemple) évite que les copies s'accumulent.
- Le `.env` contient les secrets (base, Discord) : il doit rester lisible par vous seul (`chmod 600 .env`, fait à l'installation ; `ls -l .env` doit afficher `-rw-------`).

### Bot Discord

- **Jeton de bot du site** (`DISCORD_BOT_TOKEN`, facultatif mais recommandé) : dans l'application Discord du site, onglet Bot → Reset Token, puis inviter ce bot sur le serveur (OAuth2 → URL Generator, scope `bot`, aucune permission). Les rôles de chacun (grade, rôle membre) sont alors relus toutes les 10 minutes : un rôle retiré sur Discord compte aussitôt et un membre parti du serveur est déconnecté. Sans lui, seulement à la connexion suivante (7 jours au plus, durée d'une session). Ce n'est pas le bot géré à part (`BOT_API_URL`).
Géré à part ([roxwood-network-famille](https://github.com/poulpizar01/roxwood-network-famille)). Détail de la liaison, des rubriques lues, du cache et des limites : [docs/api.md](../docs/api.md#api-du-bot-discord-relayée). L'espace membre lit ses données via son **API REST, en lecture seule** : rien n'est écrit dans le bot ni stocké côté site.
- `.env` : `BOT_API_URL` = URL publique de l'API du bot (vide = pages liées au bot désactivées). Le bot limite chaque serveur Discord à 300 requêtes par quart d'heure ; le site s'arrête à `BOT_BUDGET` (240 par défaut, la marge couvre les appels simultanés) et se recale sur le compteur du bot, y compris après un redémarrage.
- Discord : un admin du serveur déclare le site comme site externe du bot : `/config site-externe set url:https://<domaine>/espace/bot-callback.html`.
- **Une seule URL par serveur Discord** : le bot renvoie chaque connexion vers le dernier site externe déclaré. Déclarer `http://localhost:3000/…` pour tester en dev coupe la connexion au bot en prod (et inversement). Tester le bot en dev sur un **serveur Discord de test**, ou redéclarer l'URL de prod juste après.
- **Rôle membre du bot** : `/config role set membre @Rôle`. Le bot ne délivre de jeton et ne répond qu'aux porteurs de ce rôle (et à ses admins) ; tant qu'il n'est pas réglé, seuls ses admins passent. C'est en principe le même rôle que le rôle membre du site (Gestion → Hiérarchie).
- Version du bot : celle qui porte le rôle membre et la route `/api/roles` (liste des rôles du serveur, pour choisir un rôle par son nom dans Hiérarchie). Avec un bot plus ancien, Hiérarchie retombe sur l'identifiant à coller.
- Chaque membre connecte son compte au bot depuis l'espace membre (bouton « Connecter mon compte au bot ») : le bot vérifie son identité Discord et renvoie un jeton personnel (7 jours), gardé dans sa session. Les droits (rôle membre, admin) sont ceux de ses rôles Discord, revérifiés par le bot à chaque lecture.

## Application Discord
Une par site.
1. https://discord.com/developers/applications → New Application (nom du site)
2. OAuth2 → Client ID / Client Secret → `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` dans `.env`
3. OAuth2 → Redirects → ajouter `https://<domaine>/auth/discord/callback`
4. `DISCORD_GUILD_ID` = ID du serveur (mode développeur → clic droit sur le serveur → Copier l'identifiant). Seuls ses membres peuvent entrer.
5. Le **propriétaire du serveur Discord** est propriétaire du site : validé d'office, tous les droits quel que soit son grade (vérifié à chaque connexion). C'est lui qui crée les premiers grades.
6. Grades et rôle membre : ils se règlent dans l'espace membre → Gestion → Hiérarchie (nom, ordre, couleur, droits, grade par défaut, rôle Discord lié). Les rôles Discord se choisissent par leur nom quand le compte est relié au bot ; sinon, coller leur identifiant. Rôles et grades sont relus à chaque connexion (au plus tard 7 jours, durée d'une session).

Toutes les variables : [`.env.example`](../.env.example).
