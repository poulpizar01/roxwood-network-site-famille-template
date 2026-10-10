// Grade d'un compte d'après ses rôles Discord : fonction pure (sans base ni configuration), testée par
// test/grade-connexion.test.ts. Appelée à la connexion (routes/auth.ts) et par la relecture du bot
// (synchro-discord.ts), avec les grades du sommet à la base :
//  - grade par rôle : le plus élevé dont le rôle Discord est porté ;
//  - un grade lié à un rôle que le compte ne porte plus (rétrogradé ou retiré sur Discord) est perdu : retour au grade
//    par défaut ;
//  - un grade sans rôle Discord (attribué à la main dans Gestion) est conservé, sauf pour un ancien propriétaire
//    (serveur transféré) : ce grade a pu lui venir d'office, ou de lui seul ;
//  - un grade attribué à la main plus haut que celui du rôle l'emporte : sinon, quiconque peut lier un grade inférieur
//    à un rôle porté par tous le ferait, et ses supérieurs tomberaient à ce grade.
type RangRole = { key: string; discordRoleId: string | null; isDefault: boolean };

export function gradeConnexion(ranks: readonly RangRole[], roles: readonly string[], actuelKey: string | null | undefined, exProprietaire: boolean) {
  const index = (key: string | null | undefined) => { const i = ranks.findIndex(r => r.key === key); return i < 0 ? ranks.length : i; };
  const parRole = ranks.find(r => r.discordRoleId && roles.includes(r.discordRoleId))?.key ?? null;
  const actuel = ranks.find(r => r.key === actuelKey);
  const roleRetire = !!actuel?.discordRoleId && !roles.includes(actuel.discordRoleId);
  const exProprio = exProprietaire && !actuel?.discordRoleId;
  const conserve = roleRetire || exProprio ? ranks.find(r => r.isDefault)?.key ?? null : actuelKey ?? null;
  const manuelPlusHaut = !!conserve && !ranks.find(r => r.key === conserve)?.discordRoleId && index(conserve) < index(parRole);
  return { grade: manuelPlusHaut ? conserve : parRole ?? conserve, parRole };
}

// Compte relu par le bot entre deux connexions : roles portés sur le serveur, ou null s'il n'y est plus (ses grades
// liés à un rôle tombent, son rôle membre aussi). roleMembre : rôle membre réglé (Gestion → Hiérarchie), ou null.
type MembreLu = { rankKey: string | null; memberRole: string | null };
export function synchroMembre(ranks: readonly RangRole[], membre: MembreLu, roles: readonly string[] | null, roleMembre: string | null) {
  const portes = roles ?? [];
  const { grade } = gradeConnexion(ranks, portes, membre.rankKey, false);
  const memberRole = roleMembre && portes.includes(roleMembre) ? roleMembre : null;
  return { parti: roles === null, rankKey: grade, memberRole, change: roles === null || grade !== membre.rankKey || memberRole !== membre.memberRole };
}
