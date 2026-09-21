// Utilidades compartidas por los scripts del flujo. Los invoca actions/github-script.
'use strict';

const LABELS = {
    request: 'registro-secreto',
    errors: 'con-errores',
    registered: 'registrado',
    rejected: 'rechazado',
    failed: 'fallido',
    permissionAlert: 'alerta-permisos',
    reconciliationAlert: 'alerta-conciliacion',
};

// Nomenclatura de la empresa: azkv<código>eu2<d|c|p><nn>. La letra define el ambiente y la puerta de aprobación.
const VAULT_PATTERN = /^azkv[a-z]{3,8}eu2([dcp])\d{2}$/;
const ENVIRONMENTS = {
    d: { label: 'desarrollo', gate: 'registro-secretos' },
    c: { label: 'certificación', gate: 'registro-secretos' },
    p: { label: 'producción', gate: 'registro-secretos-prod' },
};

// Nombre del secreto del KV: minúsculas, números y guiones; Key Vault admite hasta 127 caracteres.
const SECRET_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SECRET_NAME_MAX = 127;

// El nombre del secret de GitHub no lo elige nadie: sale del número del issue.
const githubSecretName = (issueNumber) => `VALOR_ISSUE_${issueNumber}`;

const issueRef = ({ repo, issue }) => ({ owner: repo.owner, repo: repo.repo, issue_number: issue.number });
const repoUrl = ({ serverUrl, repo }) => `${serverUrl}/${repo.owner}/${repo.repo}`;
const runUrl = (context) => `${repoUrl(context)}/actions/runs/${context.runId}`;

// Lista de logins separada por comas, desde una variable del repo.
const loginList = (value) => (value || '').split(',').map((login) => login.trim()).filter(Boolean);
const mentions = (value) => loginList(value).map((login) => `@${login}`).join(' ');

// Los Issue Forms rinden cada campo como '### Etiqueta' seguido del valor, hasta el próximo '###'.
function readField(body, label) {
    const match = body.match(new RegExp(`###\\s*${label}\\s*\\n+([\\s\\S]*?)(?=\\n###\\s|$)`, 'i'));
    const value = match ? match[1].trim() : '';
    return value === '_No response_' ? '' : value;
}

function readRequest(body) {
    return {
        name: readField(body, 'Nombre del secreto'),
        vault: readField(body, 'Key Vault'),
        justification: readField(body, 'Justificación'),
    };
}

function vaultEnvironment(vault) {
    const match = vault.match(VAULT_PATTERN);
    return match ? ENVIRONMENTS[match[1]] : null;
}

// Un solo comentario del bot por pedido, armado por etapas: cada workflow reemplaza la suya y deja las demás.
const MARKER = '<!-- registro-secretos:estado -->';
const STAGES = ['validacion', 'chequeo', 'valor', 'resultado', 'limpieza'];
const BOT_LOGIN = 'github-actions[bot]';

function parseStages(body) {
    const stages = {};
    for (const stage of STAGES) {
        const match = body.match(new RegExp(`<!-- ${stage} -->\\n([\\s\\S]*?)\\n<!-- /${stage} -->`));
        if (match) stages[stage] = match[1];
    }
    return stages;
}

// changes: { etapa: markdown } para reemplazar, { etapa: null } para quitarla.
async function updateStages(github, context, changes) {
    const ref = issueRef(context);
    const comments = await github.paginate(github.rest.issues.listComments, ref);
    const current = comments.find((comment) => comment.user?.login === BOT_LOGIN && comment.body?.startsWith(MARKER));
    const stages = { ...parseStages(current?.body || ''), ...changes };
    const body = [MARKER, ...STAGES.filter((stage) => stages[stage])
        .map((stage) => `<!-- ${stage} -->\n${stages[stage]}\n<!-- /${stage} -->`)].join('\n\n');
    if (current) {
        await github.rest.issues.updateComment({ owner: ref.owner, repo: ref.repo, comment_id: current.id, body });
    } else {
        await github.rest.issues.createComment({ ...ref, body });
    }
}

// Corridas de "Registrar secreto" que esperan aprobación; con issueNumber, solo las de ese pedido.
async function waitingRegisterRuns(github, context, issueNumber) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
        owner: context.repo.owner, repo: context.repo.repo, workflow_id: 'registrar-secreto.yml', status: 'waiting', per_page: 100 });
    return runs.map((run) => ({ run, issue: Number(run.display_title.match(/#(\d+)$/)?.[1]) }))
        .filter(({ issue }) => !issueNumber || issue === issueNumber);
}

async function removeLabel(github, context, name) {
    try {
        await github.rest.issues.removeLabel({ ...issueRef(context), name });
    } catch (error) {
        if (error.status !== 404) throw error;  // no la tenía: nada que hacer
    }
}

module.exports = {
    LABELS, VAULT_PATTERN, SECRET_NAME_PATTERN, SECRET_NAME_MAX,
    githubSecretName, issueRef, repoUrl, runUrl, loginList, mentions,
    readField, readRequest, vaultEnvironment, updateStages, removeLabel, waitingRegisterRuns,
};
