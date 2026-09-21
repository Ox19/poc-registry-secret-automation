// Barrido de secrets de GitHub del repo central: todo lo que no sea el VALOR_ISSUE_<n> de un pedido abierto y
// con menos de 24 h sobra. El repo no tiene secrets de GitHub propios, así que se puede "volar todo" lo demás.
'use strict';

const { LABELS, githubSecretName, updateStages } = require('./common');

const TTL_HOURS = 24;
const VALUE_PATTERN = /^VALOR_ISSUE_(\d+)$/;

// Paso 1, con el token del workflow: qué pedidos siguen abiertos.
async function openRequests({ github, context, core }) {
    const issues = await github.paginate(github.rest.issues.listForRepo, {
        owner: context.repo.owner, repo: context.repo.repo, state: 'open', labels: LABELS.request, per_page: 100 });
    core.setOutput('open', JSON.stringify(issues.filter((issue) => !issue.pull_request).map((issue) => issue.number)));
}

// Paso 2, con el token de la App: decide y borra. Solo ve nombres y fechas, nunca valores.
async function sweep({ github, context, core }) {
    const open = new Set(JSON.parse(process.env.OPEN_REQUESTS || '[]'));
    const repo = { owner: context.repo.owner, repo: context.repo.repo };
    const secrets = await github.paginate(github.rest.actions.listRepoSecrets, { ...repo, per_page: 100 });
    const now = Date.now();
    const deleted = [];
    const expired = [];

    for (const secret of secrets) {
        const match = secret.name.match(VALUE_PATTERN);
        const issueNumber = match && Number(match[1]);
        const ageHours = (now - new Date(secret.updated_at).getTime()) / 3600000;
        let reason = null;
        if (!match) reason = 'otro nombre';
        else if (!open.has(issueNumber)) reason = 'pedido cerrado';
        else if (ageHours > TTL_HOURS) reason = `vencido (${Math.floor(ageHours)} h sin aprobar)`;
        if (!reason) continue;

        await github.rest.actions.deleteRepoSecret({ ...repo, secret_name: secret.name });
        deleted.push(`\`${secret.name}\`: ${reason}`);
        if (match && open.has(issueNumber)) expired.push(issueNumber);
    }

    await core.summary.addHeading('Barrido de secrets de GitHub', 3)
        .addRaw(deleted.length ? deleted.map((line) => `- ${line}`).join('\n') : 'Nada que borrar.').write();
    core.setOutput('expired', JSON.stringify(expired));
}

// Paso 3, con el token del workflow: avisa en cada pedido que su valor venció.
async function notify({ github, context }) {
    for (const issueNumber of JSON.parse(process.env.EXPIRED || '[]')) {
        const issueContext = { ...context, issue: { ...context.issue, number: issueNumber } };
        await updateStages(github, issueContext, { valor: ['### ⏰ Valor vencido', '',
            `El secret de GitHub \`${githubSecretName(issueNumber)}\` pasó ${TTL_HOURS} h sin aprobarse y se borró.`,
            'Volvé a cargarlo cuando el analista esté disponible y comentá `/cargado`.'].join('\n') });
    }
}

module.exports = { openRequests, sweep, notify };
