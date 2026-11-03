// Réécrit en toutes lettres les nombres que Parakeet écrit en chiffres
// (« 42 300 », « 8% », « 14h30 », « ventes.csv »), pour que le WER ne compte
// que les vraies erreurs de prononciation. Français de France (soixante-dix).
'use strict';
const U = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const T = { 20: 'vingt', 30: 'trente', 40: 'quarante', 50: 'cinquante', 60: 'soixante', 80: 'quatre-vingt' };
function under100(n) {
  if (n <= 16) return U[n];
  if (n < 20) return `dix-${U[n - 10]}`;
  if (n < 70 || (n >= 80 && n < 90)) {
    const t = n - (n % 10), u = n % 10;
    if (u === 0) return t === 80 ? 'quatre-vingts' : T[t];
    return `${T[t]}${u === 1 && t !== 80 ? ' et un' : `-${U[u]}`}`;
  }
  const base = n < 80 ? 60 : 80;
  const r = n - base;
  return `${T[base]}${r === 11 && base === 60 ? ' et onze' : `-${under100(r)}`}`;
}
function under1000(n) {
  if (n < 100) return under100(n);
  const c = Math.floor(n / 100), r = n % 100;
  const head = c === 1 ? 'cent' : `${U[c]} cent${r === 0 ? 's' : ''}`;
  return r === 0 ? head : `${head} ${under100(r)}`;
}
function toWords(n) {
  if (n < 1000) return under1000(n);
  const k = Math.floor(n / 1000), r = n % 1000;
  const head = k === 1 ? 'mille' : `${under1000(k)} mille`;
  return r === 0 ? head : `${head} ${under1000(r)}`;
}
function spellNumbersFr(text) {
  return text
    .replace(/\.csv\b/gi, ' point csv')
    .replace(/\b(\d{1,2})h(\d{2})?\b/g, (_, h, m) => `${toWords(+h)} heures${m ? ` ${toWords(+m)}` : ''}`)
    .replace(/(\d{1,3}(?:[  ]\d{3})+|\d+)\s?%/g, (_, d) => `${toWords(+d.replace(/\D/g, ''))} pour cent`)
    .replace(/\d{1,3}(?:[  ]\d{3})+|\d+/g, (d) => toWords(+d.replace(/\D/g, '')));
}
module.exports = { spellNumbersFr, toWords };
