// Conciliación: compara lo que anotó el flujo (issues `registrado`) con lo que hay de verdad en los KV.
// Es la cámara de la puerta trasera (el portal de Azure): no impide, detecta. Solo nombres y etiquetas.
'use strict';

const fs = require('node:fs');
const { LABELS, mentions, readRequest } = require('./common');

const FLOW_TAG = 'registrado-por';

// Paso 1: los pedidos registrados y los KV donde viven sus secretos.
async function registeredRequests({ github, context, core }) {
    const issues = await github.paginate(github.rest.issues.listForRepo, {
        owner: context.repo.owner, repo: context.repo.repo, state: 'all', labels: LABELS.registered, per_page: 100 });
    const requests = issues.filter((issue) => !issue.pull_request)
        .map((issue) => ({ number: issue.number, ...readRequest(issue.body || '') }));
    core.setOutput('requests', JSON.stringify(requests));
    core.setOutput('vaults', [...new Set(requests.map((request) => request.vault))].join(' '));
}

// Paso 3: las tres preguntas, con lo que listó Azure en el paso 2.
async function compare({ github, context, core }) {
    const requests = JSON.parse(process.env.REQUESTS || '[]');
    const inventory = JSON.parse(fs.readFileSync(process.env.INVENTORY_FILE, 'utf8'));
    const flowStart = new Date(process.env.FLOW_START);
    const findings = [];

    for (const [vault, listing] of Object.entries(inventory)) {
        if (!listing.ok) { findings.push(`- KV \`${vault}\`: **no se pudo revisar** (red cerrada o sin permiso).`); continue; }
        const byName = new Map(listing.secrets.map((secret) => [secret.name, secret]));

        // 1 · Lo que registró el flujo, ¿sigue en el KV?
        for (const request of requests.filter((candidate) => candidate.vault === vault)) {
            const secret = byName.get(request.name);
            if (!secret) findings.push(`- #${request.number}: el secreto \`${request.name}\` **ya no está** en el KV \`${vault}\`: alguien lo borró desde el portal.`);
            // 3 · ¿Alguien lo pisó? La última versión sin la etiqueta del flujo la escribió otro.
            else if (secret.tags?.[FLOW_TAG] !== 'registro-secretos') findings.push(`- #${request.number}: la última versión de \`${request.name}\` en el KV \`${vault}\` **no la creó el flujo**: alguien lo pisó desde el portal.`);
        }
        // 2 · Lo que hay en el KV, ¿tiene pedido? Solo cuenta lo creado después del arranque del flujo.
        for (const secret of listing.secrets) {
            const createdAfterStart = new Date(secret.created) > flowStart;
            if (createdAfterStart && !secret.tags?.[FLOW_TAG]) findings.push(`- KV \`${vault}\`: el secreto \`${secret.name}\` **no tiene pedido**: se creó a mano en el portal.`);
        }
    }

    const vaults = Object.keys(inventory).length;
    if (!findings.length) {
        await core.summary.addRaw(`Conciliación: ${requests.length} pedidos registrados en ${vaults} KV, todo cuadra.`).write();
        return;
    }
    const body = ['### 🔎 La conciliación encontró diferencias', '',
        'Compara lo que anotó el flujo con lo que hay de verdad en los KV (solo nombres y etiquetas, nunca valores).', '',
        ...findings, '', mentions(process.env.SECURITY_TEAM)].join('\n');
    await github.rest.issues.create({ owner: context.repo.owner, repo: context.repo.repo,
        title: `[Conciliación] ${findings.length} diferencia(s) — ${new Date().toISOString().slice(0, 10)}`,
        body, labels: [LABELS.reconciliationAlert] });
    await core.summary.addRaw(body).write();
}

module.exports = { registeredRequests, compare };
