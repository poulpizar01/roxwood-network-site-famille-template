// Grade et rôle membre d'après les rôles Discord (src/grade-connexion.ts), à la connexion et à la relecture du bot.
// Une erreur ici donne ou garde des accès à tort, sans rien d'anormal à l'écran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeConnexion, synchroMembre } from '../src/grade-connexion.js';

// du sommet à la base : chef attribué à la main, lieutenant et soldat liés à des rôles, recrue par défaut
const RANKS = [
  { key: 'chef', discordRoleId: null, isDefault: false },
  { key: 'lieutenant', discordRoleId: '1001', isDefault: false },
  { key: 'soldat', discordRoleId: '1002', isDefault: false },
  { key: 'recrue', discordRoleId: null, isDefault: true },
];
const MEMBRE = '2000';

test('connexion : le plus haut grade dont le rôle est porté', () => {
  assert.equal(gradeConnexion(RANKS, ['1002', '1001'], 'recrue', false).grade, 'lieutenant');
});

test('connexion : rôle retiré, retour au grade par défaut', () => {
  assert.equal(gradeConnexion(RANKS, [], 'soldat', false).grade, 'recrue');
});

test('connexion : grade attribué à la main plus haut que celui du rôle, gardé ; ancien propriétaire, perdu', () => {
  assert.equal(gradeConnexion(RANKS, ['1002'], 'chef', false).grade, 'chef');
  assert.equal(gradeConnexion(RANKS, ['1002'], 'chef', true).grade, 'soldat');
});

test('relecture : rôle membre gardé, rien ne change ; retiré, accès perdu sans attendre la connexion', () => {
  const garde = synchroMembre(RANKS, { rankKey: 'soldat', memberRole: MEMBRE }, ['1002', MEMBRE], MEMBRE);
  assert.deepEqual([garde.memberRole, garde.change], [MEMBRE, false]);
  const retire = synchroMembre(RANKS, { rankKey: 'soldat', memberRole: MEMBRE }, ['1002'], MEMBRE);
  assert.deepEqual([retire.rankKey, retire.memberRole, retire.change], ['soldat', null, true]);
});

test('relecture : membre parti, grades liés et rôle membre perdus, grade manuel gardé', () => {
  assert.deepEqual(synchroMembre(RANKS, { rankKey: 'soldat', memberRole: MEMBRE }, null, MEMBRE), { parti: true, rankKey: 'recrue', memberRole: null, change: true });
  assert.equal(synchroMembre(RANKS, { rankKey: 'chef', memberRole: MEMBRE }, null, MEMBRE).rankKey, 'chef');
});

test('relecture : rôle membre non réglé, personne ne l’a', () => {
  assert.equal(synchroMembre(RANKS, { rankKey: 'recrue', memberRole: null }, [MEMBRE], null).memberRole, null);
});
