// Valida la solicitud, nunca el valor: `check` al abrir el issue y `recheck` justo antes de generar.
// Lo invoca actions/github-script, que inyecta github, context y core.
'use strict';

const crypto = require('node:crypto');
const { REGISTERED_LABEL, issueRef, runUrl } = require('./common');

// El formulario no muestra los vaults permitidos: el control es esta lista, y vale igual aunque editen el issue.
const ALLOWED_VAULTS = ['kv-poc-secretos-78e549'];
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Define quién escribe en la bóveda: github[bot] o la persona que recibió el valor.
const GENERATED = 'Lo genera un sistema';
const ALLOWED_ORIGINS = [GENERATED, 'Lo entrega un proveedor'];

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
        origin: readField(body, 'De dónde viene el valor'),
    };
    const errors = [];

    if (!NAME_PATTERN.test(request.name)) errors.push(`Nombre inválido: \`${request.name}\`. Solo minúsculas, números y guiones.`);
    if (!ALLOWED_VAULTS.includes(request.vault)) errors.push(`Key Vault \`${request.vault}\` no está autorizado.`);
    if (!ALLOWED_ORIGINS.includes(request.origin)) errors.push(`Origen del valor inválido: \`${request.origin}\`.`);

    for (const [pattern, kind] of LEAK_PATTERNS) {
        if (pattern.test(body)) errors.push(`🚨 **Parece un ${kind} EN CLARO.** Rotalo ya: quedó en el historial del issue.`);
    }
    return { request, errors };
}

function render({ request, errors }, runLink) {
    const rows = [['Nombre', request.name], ['Key Vault', request.vault], ['Origen del valor', request.origin]];
    return [
        errors.length ? '### ❌ Solicitud rechazada' : '### ✅ Solicitud válida', '',
        '| Campo | Valor |', '|---|---|',
        ...rows.map(([label, value]) => `| ${label} | \`${value}\` |`), '',
        ...(errors.length
            ? ['**Problemas encontrados:**', '', ...errors.map((e) => `- ${e}`), '', 'La solicitud se cerró: para corregirla, abrí otra.']
            : [`Queda esperando la **aprobación de Seguridad** en el [run](${runLink}).`, '',
               request.origin === GENERATED
                   ? 'Al aprobarse, el sistema pide el valor y lo registra: nadie lo ve.'
                   : 'Al aprobarse, se te avisa para que cargues vos el valor en el Key Vault. No lo pegues acá.']),
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
    for (const key of ['name', 'vault']) core.setOutput(key, request[key]);
    // El workflow decide con esto si genera el valor o si solo avisa que ya se puede cargar.
    core.setOutput('generated', String(request.origin === GENERATED));
}

module.exports = { check, recheck };
