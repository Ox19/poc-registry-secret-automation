// Valida la solicitud, nunca el valor: `check` al abrir el issue y `recheck` justo antes de generar.
// Lo invoca actions/github-script, que inyecta github, context y core.
'use strict';

const crypto = require('node:crypto');
const { REGISTERED_LABEL, issueRef, runUrl } = require('./common');

// Los dropdowns del formulario son solo UX: el issue se puede editar, así que el control son estas listas.
const ALLOWED_VAULTS = ['kv-poc-secretos-78e549'];
const ALLOWED_ENVIRONMENTS = ['desarrollo', 'certificacion', 'produccion'];
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Date no falla con '2026-13-45' y corre '2027-02-31' a marzo: se exige que la fecha exista tal cual.
function isRealDate(text) {
    const time = Date.parse(text);
    return DATE_PATTERN.test(text) && !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

// Guardarraíl: secretos pegados en claro por error.
const LEAK_PATTERNS = [
    [/gh[pousr]_[A-Za-z0-9]{16,}/, 'token de GitHub'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clave privada'],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'token de Slack'],
    [/AKIA[0-9A-Z]{16}/, 'access key de AWS'],
    [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, 'JWT'],
];

// Los Issue Forms rinden cada campo como '### Etiqueta' + valor.
function readField(body, label) {
    const match = body.match(new RegExp(`### ${label}\\s*\\n+([^\\n]+)`, 'i'));
    return match ? match[1].trim() : '';
}

function validate(body) {
    const request = {
        name: readField(body, 'Nombre del secreto'),
        vault: readField(body, 'Key Vault destino'),
        environment: readField(body, 'Ambiente'),
        app: readField(body, 'Aplicación dueña'),
        expiry: readField(body, 'Fecha de expiración'),
    };
    const errors = [];

    if (!NAME_PATTERN.test(request.name)) errors.push(`Nombre inválido: \`${request.name}\`. Solo minúsculas, números y guiones.`);
    if (!ALLOWED_VAULTS.includes(request.vault)) errors.push(`Key Vault \`${request.vault}\` no está en la lista blanca.`);
    if (!ALLOWED_ENVIRONMENTS.includes(request.environment)) errors.push(`Ambiente inválido: \`${request.environment}\`.`);
    if (!NAME_PATTERN.test(request.app)) errors.push(`Aplicación inválida: \`${request.app}\`. Solo minúsculas, números y guiones.`);
    if (!isRealDate(request.expiry)) errors.push(`Fecha de expiración inválida: \`${request.expiry}\`. Formato AAAA-MM-DD y fecha existente.`);
    else if (new Date(request.expiry) <= new Date()) errors.push(`La fecha de expiración \`${request.expiry}\` ya pasó.`);

    for (const [pattern, kind] of LEAK_PATTERNS) {
        if (pattern.test(body)) errors.push(`🚨 **Parece un ${kind} EN CLARO.** Rotalo ya: quedó en el historial del issue.`);
    }
    return { request, errors };
}

function render({ request, errors }, runLink) {
    const rows = [['Nombre', request.name], ['Key Vault', request.vault], ['Ambiente', request.environment],
                  ['Aplicación', request.app], ['Expira', request.expiry]];
    return [
        errors.length ? '### ❌ Solicitud rechazada' : '### ✅ Solicitud válida', '',
        '| Campo | Valor |', '|---|---|',
        ...rows.map(([label, value]) => `| ${label} | \`${value}\` |`), '',
        ...(errors.length
            ? ['**Problemas encontrados:**', '', ...errors.map((e) => `- ${e}`), '', 'La solicitud se cerró: para corregirla, abrí otra.']
            : [`Queda esperando la **aprobación de Seguridad** en el [run](${runLink}). Al aprobarse, el sistema genera el valor: nadie lo ve.`]),
    ].join('\n');
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function fetchIssue(github, context) {
    const { data } = await github.rest.issues.get(issueRef(context));
    return data;
}

// Al abrir el issue. El resultado va también al summary del run: es lo que ve quien aprueba.
async function check({ github, context, core }) {
    const body = (await fetchIssue(github, context)).body || '';
    const result = validate(body);
    const report = render(result, runUrl(context));

    await github.rest.issues.createComment({ ...issueRef(context), body: report });
    await core.summary.addRaw(report).write();
    if (result.errors.length) {
        await github.rest.issues.update({ ...issueRef(context), state: 'closed', state_reason: 'not_planned' });
        core.setFailed('La solicitud no pasó la validación.');
        return;
    }
    core.setOutput('body_sha256', sha256(body));
}

// Justo antes de generar: lo aprobado tiene que ser exactamente lo validado, y registrarse una sola vez.
async function recheck({ github, context, core }) {
    const issue = await fetchIssue(github, context);
    const body = issue.body || '';
    const labels = issue.labels.map((label) => label.name ?? label);

    if (issue.state !== 'open') return core.setFailed('El issue ya no está abierto.');
    if (labels.includes(REGISTERED_LABEL)) return core.setFailed('La solicitud ya fue registrada.');
    if (sha256(body) !== process.env.APPROVED_SHA256) return core.setFailed('El issue cambió después de validarse. Abrí otra solicitud.');

    const { request, errors } = validate(body);
    if (errors.length) return core.setFailed(`La solicitud dejó de ser válida: ${errors.join(' ')}`);
    for (const key of ['name', 'vault', 'expiry']) core.setOutput(key, request[key]);
}

module.exports = { check, recheck };
