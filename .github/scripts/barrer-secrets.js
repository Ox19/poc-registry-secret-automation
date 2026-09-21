// Barrido de secrets de GitHub del repo central: todo lo que no sea el VALOR_ISSUE_<n> de un pedido abierto y
// con menos de 24 h sobra. El repo no tiene secrets de GitHub propios, así que se puede "volar todo" lo demás.
'use strict';

const { LABELS, githubSecretName, updateStages, waitingRegisterRuns } = require('./common');

const TTL_HOURS = 24;
const VALUE_PATTERN = /^VALOR_ISSUE_(\d+)$/;

// Paso 1, con el token del workflow: qué pedidos siguen abiertos, y cancela las esperas de aprobación
// de más de 24 h. GitHub fija los secrets de una corrida al crearla: la espera guarda su propia copia del
// valor, así que borrar el secret de GitHub no alcanza.
async function openRequests({ github, context, core }) {
    const issues = await github.paginate(github.rest.issues.listForRepo, {
        owner: context.repo.owner, repo: context.repo.repo, state: 'open', labels: LABELS.request, per_page: 100 });
    core.setOutput('open', JSON.stringify(issues.filter((issue) => !issue.pull_request).map((issue) => issue.number)));

    const stale = [];
    for (const { run, issue } of await waitingRegisterRuns(github, context)) {
        if ((Date.now() - new Date(run.created_at).getTime()) / 3600000 <= TTL_HOURS) continue;
        await github.rest.actions.cancelWorkflowRun({ owner: context.repo.owner, repo: context.repo.repo, run_id: run.id });
        stale.push(issue);
    }
    core.setOutput('stale', JSON.stringify(stale));
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
    const issues = new Set([...JSON.parse(process.env.EXPIRED || '[]'), ...JSON.parse(process.env.STALE || '[]')]);
    for (const issueNumber of issues) {
        const issueContext = { ...context, issue: { ...context.issue, number: issueNumber } };
        await updateStages(github, issueContext, { valor: ['### ⏰ Valor vencido', '',
            `Pasaron ${TTL_HOURS} h sin aprobación: se borró el secret de GitHub \`${githubSecretName(issueNumber)}\` o se canceló la espera.`,
            'Volvé a cargar el valor si hace falta y comentá `/cargado` cuando el analista esté disponible.'].join('\n') });
    }
}

module.exports = { openRequests, sweep, notify };
