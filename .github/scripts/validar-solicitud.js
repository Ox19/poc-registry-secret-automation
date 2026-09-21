// Valida el pedido, nunca el valor: `check` al abrir o editar el issue, `reportPrecheck` con lo que vio
// Azure antes de pedir la aprobación, y `recheck` justo antes de escribir en el KV.
'use strict';

const crypto = require('node:crypto');
const {
    LABELS, SECRET_NAME_PATTERN, SECRET_NAME_MAX, githubSecretName, issueRef, repoUrl, loginList, mentions,
    readRequest, vaultEnvironment, updateStages, removeLabel,
} = require('./common');

// Guardarraíl: el valor de un secreto pegado en el texto por error.
const LEAK_PATTERNS = [
    [/gh[pousr]_[A-Za-z0-9]{16,}/, 'token de GitHub'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clave privada'],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'token de Slack'],
    [/AKIA[0-9A-Z]{16}/, 'access key de AWS'],
    [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, 'JWT'],
];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function validate(body, people, allowed) {
    const request = readRequest(body);
    const environment = vaultEnvironment(request.vault);
    const allowedLower = allowed.map((login) => login.toLowerCase());
    const errors = [];

    for (const login of people) {
        if (!allowedLower.includes(login.toLowerCase())) errors.push(`@${login} no pertenece a un equipo habilitado para pedir secretos.`);
    }
    if (!SECRET_NAME_PATTERN.test(request.name) || request.name.length > SECRET_NAME_MAX) {
        errors.push(`El nombre del secreto \`${request.name}\` no es válido: solo minúsculas, números y guiones, hasta ${SECRET_NAME_MAX} caracteres.`);
    }
    if (!environment) {
        errors.push(`El nombre del KV \`${request.vault}\` no respeta la nomenclatura \`azkv<código>eu2<d|c|p><nn>\`.`);
    }
    if (!request.justification) errors.push('Falta la justificación.');

    const leak = LEAK_PATTERNS.find(([pattern]) => pattern.test(body));
    return { request, environment, errors, leak: leak?.[1] };
}

function summary(request, environment) {
    const ambient = environment.label === 'producción' ? '**producción** ⚠️' : environment.label;
    return ['| Campo | Valor |', '|---|---|',
        `| Nombre del secreto | \`${request.name}\` |`, `| KV | \`${request.vault}\` |`,
        `| Ambiente | ${ambient} |`, `| Justificación | ${request.justification.replace(/\n+/g, ' ')} |`].join('\n');
}

// Al abrir o editar el issue. Si algo falla, el issue queda abierto para corregirlo editando.
async function check({ github, context, core }) {
    const ref = issueRef(context);
    const { data: issue } = await github.rest.issues.get(ref);
    const body = issue.body || '';
    const people = [...new Set([issue.user.login, context.payload.sender.login])];
    const result = validate(body, people, loginList(process.env.ALLOWED_REQUESTERS));
    core.setOutput('ok', 'false');

    // Un valor pegado ya salió por el issue, su historial y los correos de GitHub: se da por quemado.
    if (result.leak) {
        await updateStages(github, context, { chequeo: null, valor: null, validacion: [
            `### 🚨 Este texto parece contener un ${result.leak}`, '',
            'Consideralo **expuesto**: pedí un valor nuevo al proveedor. Un admin tiene que borrar este issue.',
            'El issue se cerró y se bloqueó; no se corrige editando.'].join('\n') });
        await github.rest.issues.update({ ...ref, state: 'closed', state_reason: 'not_planned' });
        await github.rest.issues.lock({ ...ref, lock_reason: 'resolved' });
        return core.setFailed(`Se detectó un ${result.leak} en el texto del issue.`);
    }

    if (result.errors.length) {
        await updateStages(github, context, { chequeo: null, valor: null, validacion: [
            '### ❌ El pedido tiene errores', '', ...result.errors.map((error) => `- ${error}`), '',
            'Editá el issue para corregirlo: el bot lo vuelve a revisar solo.'].join('\n') });
        await github.rest.issues.addLabels({ ...ref, labels: [LABELS.errors] });
        return;
    }

    await removeLabel(github, context, LABELS.errors);
    await updateStages(github, context, { chequeo: null, valor: null,
        validacion: ['### ✅ Pedido válido', '', summary(result.request, result.environment)].join('\n') });
    core.setOutput('ok', 'true');
    core.setOutput('name', result.request.name);
    core.setOutput('vault', result.request.vault);
    core.setOutput('gate', result.environment.gate);
    core.setOutput('environment', result.environment.label);
    core.setOutput('body_sha256', sha256(body));
}

const PRECHECK_PROBLEMS = {
    'no-existe': 'el KV no existe o su nombre está mal escrito',
    'red-cerrada': 'el KV tiene la red cerrada: el runner no llega (lo resuelve Cloud)',
    'sin-permiso': 'la identidad del flujo no tiene permiso en este KV (Access Policies o falta el rol: lo resuelve Cloud)',
    'nombre-existe': 'ya existe un secreto con ese nombre en el KV: elegí otro nombre del secreto',
    otro: 'Azure respondió un error inesperado (ver el log de la corrida)',
};

// Después del chequeo previo en Azure: si pasó, indica cómo cargar el valor y avisa a Seguridad.
async function reportPrecheck({ github, context, core }) {
    const { PROBLEM, VAULT, SECRET_NAME, ENVIRONMENT } = process.env;
    core.setOutput('ok', 'false');
    if (PROBLEM) {
        await updateStages(github, context, { chequeo: ['### ❌ Chequeo previo en Azure', '',
            `No se puede seguir: ${PRECHECK_PROBLEMS[PROBLEM] || PRECHECK_PROBLEMS.otro}.`, '',
            'Editá el issue para corregirlo: el bot lo vuelve a revisar solo.'].join('\n') });
        await github.rest.issues.addLabels({ ...issueRef(context), labels: [LABELS.errors] });
        return;
    }
    const valueName = githubSecretName(context.issue.number);
    await updateStages(github, context, { chequeo: ['### ✅ Chequeo previo en Azure', '',
        `El KV \`${VAULT}\` existe, el runner llega y el nombre del secreto \`${SECRET_NAME}\` está libre en ese KV.`, '',
        '### Siguiente paso: cargar el valor', '',
        `1. Quien recibió el valor lo carga como **secret de GitHub** con el nombre **\`${valueName}\`** en`,
        `   [Settings → Secrets and variables → Actions → New repository secret](${repoUrl(context)}/settings/secrets/actions/new).`,
        '2. Comentá `/cargado` en este issue.', '',
        `${mentions(process.env.SECURITY_TEAM)} hay un pedido esperando (ambiente: ${ENVIRONMENT}).`].join('\n') });
    core.setOutput('ok', 'true');
}

// Justo antes de escribir: lo aprobado tiene que ser exactamente lo validado, y registrarse una sola vez.
async function recheck({ github, context, core }) {
    const ref = issueRef(context);
    const { data: issue } = await github.rest.issues.get(ref);
    const labels = issue.labels.map((label) => label.name ?? label);
    const stop = (reason, message) => { core.setOutput('reason', reason); core.setFailed(message); };

    if (issue.state !== 'open') return stop('pedido-cerrado', 'El issue ya no está abierto.');
    if (labels.includes(LABELS.registered)) return stop('ya-registrado', 'El pedido ya fue registrado.');
    if (sha256(issue.body || '') !== process.env.APPROVED_SHA256) return stop('pedido-cambiado', 'El issue cambió después de validarse.');

    // Quién aprobó sale de la revisión del environment, no de quien disparó la corrida.
    const { data: reviews } = await github.rest.actions.getReviewsForRun({ owner: ref.owner, repo: ref.repo, run_id: context.runId });
    const approver = reviews.find((review) => review.state === 'approved')?.user.login || 'desconocido';
    const request = readRequest(issue.body || '');
    core.setOutput('name', request.name);
    core.setOutput('vault', request.vault);
    core.setOutput('approver', approver);
}

module.exports = { check, reportPrecheck, recheck, validate };
