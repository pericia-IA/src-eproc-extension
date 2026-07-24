# Deploying Perícia Hub to the Chrome Web Store

Step-by-step guide to publish `extension/` as a **public** Chrome Web Store extension.
Prerequisite for Step A: the backend + frontend must be deployed to a public HTTPS domain (this hasn't happened yet — do it first, then come back here).

---

## Step A — Point the extension at production

The extension is currently hardwired to the dev backend (`http://localhost:3001`). Before packaging, swap in your production URLs. In the edits below:

- `<PROD_BACKEND>` = your hosted backend origin, e.g. `https://api.periciahub.com.br`
- `<PROD_FRONTEND>` = your hosted SaaS frontend origin, e.g. `https://app.periciahub.com.br`

Both **must be HTTPS** — e-proc pages are HTTPS and Chrome blocks mixed-content requests to `http://`.

### A.1 — `pipeline.js` line 7

```js
// before
const BACKEND_ORIGIN = 'http://localhost:3001'
// after
const BACKEND_ORIGIN = '<PROD_BACKEND>'
```

### A.2 — `eproc-fill.js` line 6

Same change:

```js
const BACKEND_ORIGIN = '<PROD_BACKEND>'
```

### A.3 — `manifest.json` → `host_permissions`

Replace the localhost entry; keep the two e-proc entries:

```json
"host_permissions": [
  "<PROD_BACKEND>/*",
  "https://eproc1g.trf6.jus.br/*",
  "https://eproc1g-down.trf6.jus.br/*"
],
```

### A.4 — `manifest.json` → first `content_scripts` entry (saas-bridge)

Replace the two localhost matches with the production frontend:

```json
{
  "matches": ["<PROD_FRONTEND>/*"],
  "js": ["saas-bridge.js"],
  "run_at": "document_idle"
},
```

> **Do not keep the localhost matches in the public build.** A published extension that injects a script into every `localhost` page invites store rejection (and would run on other developers' local apps). For local development, keep using the unpacked copy from this repo with its localhost values.

### A.5 — Version bump

- `manifest.json` line 4: `"version": "1.0.0"`
- `popup.html` line 15: `<div class="version">v1.0.0</div>` (keep in sync with the manifest)

---

## Step B — Publish the privacy policy on GitHub Pages

The store **requires** a privacy policy at a public, persistent URL because the extension handles personal and health data. The policy text is ready at `extension/store-assets/privacy-policy.md` — fill in the two placeholders (`[EMAIL DE CONTATO]`, `[DATA]`) before publishing.

Use a small **separate public repo** (GitHub Pages on the free plan only works on public repos, and you don't want to open-source this product repo):

```bash
mkdir /tmp/pericia-hub-privacy && cd /tmp/pericia-hub-privacy
git init -b main
cp <this-repo>/extension/store-assets/privacy-policy.md index.md
git add . && git commit -m "Privacy policy"
gh repo create pericia-hub-privacy --public --source=. --push
```

Then on GitHub: repo → **Settings → Pages → Build and deployment** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save. GitHub renders `index.md` as a page automatically (Jekyll).

After a minute the policy is live at:

```
https://<your-github-user>.github.io/pericia-hub-privacy/
```

Open it in an incognito window to confirm it loads without login. This is the URL you'll paste in the Developer Dashboard (Step F).

---

## Step C — Package the extension

From the repo root:

```bash
cd extension
zip -r ../pericia-hub-1.0.0.zip . -x '*.md' -x 'store-assets/*'
```

Rules:
- `manifest.json` must be at the **root of the zip** (zipping from inside `extension/` guarantees this — do not zip the folder itself).
- Exclude docs/assets that aren't part of the extension (the `-x` flags above).

Sanity check before uploading: unzip to a temp folder, load it via `chrome://extensions` → *Load unpacked*, and confirm no red "Erros" button appears on the card.

---

## Step D — Chrome Web Store developer account

1. Go to https://chrome.google.com/webstore/devconsole and sign in with the Google account that will own the extension.
2. Accept the developer agreement and pay the **one-time US$5 registration fee**.
3. In *Account* settings: verify your **contact email** and enable **2-Step Verification** on the Google account — both are mandatory before you can publish.

---

## Step E — Create the listing

Dashboard → **+ New item** → upload `pericia-hub-1.0.0.zip`, then fill in each tab.

### Store listing tab

- **Language:** Português (Brasil)
- **Category:** Ferramentas (Tools) / Workflow & Planning
- **Description** (draft — adjust as you like):

  > O Perícia Hub preenche automaticamente o formulário de Laudo Médico Pericial no e-proc (TRF6) com os dados processados pelo sistema Perícia Hub.
  >
  > Funcionalidades:
  > • Preenchimento automático dos campos do laudo a partir do processo analisado
  > • Resposta automática aos quesitos da parte autora
  > • Refinamento de texto da anamnese e do exame físico/mental
  > • Transcrição de documentos médicos (upload no computador ou pelo celular via QR code)
  >
  > Requer conta no sistema Perícia Hub. Uso exclusivo por médicos peritos no e-proc do TRF6.

- **Icon:** auto-taken from the manifest (`icons/final_icon128.png` — already present).
- **Screenshots:** at least one, **1280×800** (or 640×400). Capture the e-proc laudo page with the injected buttons visible (Preencher Laudo, Resposta aos quesitos, Refinar, Adicionar). **Use a test/fake process — never real patient data in screenshots.** Crop/resize to exactly 1280×800.

### Privacy practices tab — single purpose

> Preencher automaticamente o formulário de Laudo Médico Pericial no e-proc TRF6 com dados processados pelo sistema Perícia Hub.

### Privacy practices tab — permission justifications

| Permission | Justification (draft) |
|---|---|
| `storage` | Armazena temporariamente, no navegador do usuário, os dados do laudo gerados no site Perícia Hub para que a aba do e-proc possa preenchê-los no formulário. |
| `https://eproc1g.trf6.jus.br/*` | Necessário para ler e preencher o formulário de Laudo Médico Pericial no e-proc TRF6, finalidade única da extensão. |
| `https://eproc1g-down.trf6.jus.br/*` | Domínio de download de documentos do e-proc TRF6; necessário para baixar as peças do processo que alimentam o preenchimento do laudo. |
| `<PROD_BACKEND>/*` | Servidor do Perícia Hub; recebe o texto do processo para processamento (IA) e devolve os campos do laudo. |
| Content script em `<PROD_FRONTEND>` | Página do sistema Perícia Hub; o script recebe os resultados processados e os repassa à extensão. |

---

## Step F — Data disclosures (Privacy tab)

This extension transmits judicial-process content (which contains personal and medical data) to your backend, so declare honestly — the reviewer cross-checks disclosures against the manifest and the privacy policy, and a mismatch is the #1 rejection cause.

- **Data types collected/handled:** check **Personally identifiable information**, **Health information**, and **Website content**.
- Certify the Limited Use statements: data is **not sold**, **not used/transferred for purposes unrelated** to the single purpose, **not used for creditworthiness/lending**.
- **Privacy policy URL:** paste the GitHub Pages URL from Step B (goes in the developer account settings and/or the item's privacy field).
- **Trader / non-trader declaration** (EU DSA): if you publish as an individual not selling into the EU, declare **non-trader** (the practical choice here); declaring trader requires publishing a verified address/contact on the listing.

---

## Step G — Submit, review, and updates

1. **Visibility:** Public.
2. **Distribution regions:** you may restrict to Brazil only — the tool is TRF6-specific; fewer regions, fewer surprises.
3. Click **Submit for review**.

What to expect:
- Review usually takes from a few hours to a few days. Narrow, specific `host_permissions` (like yours) generally avoid the slow "in-depth review" path that broad `<all_urls>` patterns trigger.
- If **rejected**, the email states the violation ID; fix and resubmit, or use the **Appeal** button on the item page if you believe the reviewer is wrong (e.g. a permission they flagged as unused).

Publishing **updates** later:
1. Bump `"version"` in `manifest.json` (e.g. `1.0.1`) and the `popup.html` version line.
2. Re-zip (Step C), upload as a new package on the existing item, submit for review.
3. Users receive the update automatically within hours of approval.

---

## Pre-submission verification checklist

Run through this with the **production build** (post-Step A) loaded unpacked, against the production backend:

- [ ] Extension card shows no "Erros" button in `chrome://extensions`
- [ ] Popup opens and shows status + correct version
- [ ] On the SaaS site (production URL): processing a PDF posts data to the extension (popup reflects it)
- [ ] On a real e-proc laudo page: "Preencher Laudo" fills the fields
- [ ] "Resposta aos quesitos" works
- [ ] Both "Refinar" buttons work (and Desfazer)
- [ ] "Adicionar" upload works; QR/mobile flow works (**requires `MOBILE_BASE_URL` set on the production backend**)
- [ ] Privacy policy URL loads publicly (incognito test)
- [ ] Zip re-created from the final code, loaded unpacked from the unzipped copy one last time

Notes if the reviewer asks:
- `qrcode.min.js` is a locally bundled copy of the MIT-licensed *qrcode.js* library (no remote code is loaded). Minified third-party libraries are allowed; obfuscation is not — this is minification only.
