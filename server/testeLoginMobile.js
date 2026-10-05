'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  let documento = { campanhaRosa: false };
  const doc = { get: async () => ({ exists: true, data: () => documento }), set: async dados => { documento = { ...documento, ...dados }; } };
  const contexto = { module: { exports: {} }, require: nome => nome === './firestore' ? { collection: () => ({ doc: () => doc }) } : require(nome) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'loginCustom.js'), 'utf8'), contexto);
  const custom = contexto.module.exports;
  await custom.salvarFundo('desktop.png', 'master');
  await custom.salvarFundo('mobile.png', 'master', true);
  assert.equal((await custom.obter()).fundoArquivo, 'desktop.png');
  assert.equal((await custom.obter()).fundoMobileArquivo, 'mobile.png');
  const publico = custom.semDetalheInterno(await custom.obter());
  assert.equal(publico.temFundoMobile, true);
  assert.equal(publico.fundoMobileArquivo, undefined);
  await custom.removerFundo('master', true);
  assert.equal((await custom.obter()).fundoArquivo, 'desktop.png');
  assert.equal((await custom.obter()).fundoMobileArquivo, null);

  const login = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, 'public/login-custom.html'), 'utf8');
  for (const html of [login, admin]) {
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage();
    const css = login.match(/<style>([\s\S]*?)<\/style>/)[1];
    await page.setContent(`<style>${css}</style><section id="auth-screen" class="auth-screen tem-fundo" style="--login-fundo-desktop:url(desktop.png);--login-fundo-mobile:url(mobile.png)"></section>`);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.match(await page.locator('#auth-screen').evaluate(e => getComputedStyle(e).backgroundImage), /mobile\.png/);
    await page.setViewportSize({ width: 1366, height: 900 });
    assert.match(await page.locator('#auth-screen').evaluate(e => getComputedStyle(e).backgroundImage), /desktop\.png/);
    await page.locator('#auth-screen').evaluate(e => e.style.removeProperty('--login-fundo-mobile'));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.match(await page.locator('#auth-screen').evaluate(e => getComputedStyle(e).backgroundImage), /desktop\.png/);
    await page.setContent(admin.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
    await page.locator('#root').evaluate(e => e.classList.remove('hidden'));
    assert.equal(await page.getByText('Imagem para celular (mobile)', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await browser.close(); }
  console.log('✓ Login mobile: gravação/remoção independente, caminho privado, scripts válidos, seleção responsiva, fallback e painel sem overflow.');
})().catch(e => { console.error(e); process.exitCode = 1; });
