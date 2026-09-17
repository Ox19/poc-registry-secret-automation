// Compara lo que hay en la bóveda contra los pedidos aprobados: detecta secretos cargados sin pedido
// y cierra los pedidos cuyo valor ya fue cargado a mano. Nunca lee un valor, solo nombres.
'use strict';

const { REGISTERED_LABEL, PENDING_LABEL, runUrl } = require('./common');

// Los nombres de la bóveda llegan por env desde el step que corrió `az keyvault secret list`.
const vaultSecrets = () => (process.env.VAULT_SECRETS || '').split('\n').map((s) => s.trim()).filter(Boolean);

const secretName = (issue) => issue.title.replace(/^\[Secreto\]\s*/i, '').trim();

module.exports = async ({ github, context, core }) => {
    const repo = { owner: context.repo.owner, repo: context.repo.repo };
    const enBoveda = new Set(vaultSecrets());

    const { data: pendientes } = await github.rest.issues.listForRepo({
        ...repo, state: 'open', labels: PENDING_LABEL, per_page: 100 });
    const { data: registrados } = await github.rest.issues.listForRepo({
        ...repo, state: 'all', labels: REGISTERED_LABEL, per_page: 100 });

    // Un pedido aprobado cuyo secreto ya apareció en la bóveda: alguien lo cargó, se cierra.
    const cerrados = [];
    for (const issue of pendientes) {
        const nombre = secretName(issue);
        if (!enBoveda.has(nombre)) continue;
        await github.rest.issues.createComment({ ...repo, issue_number: issue.number, body: [
            '### ✅ El secreto ya está en la bóveda', '',
            `Se detectó \`${nombre}\` en el Key Vault, así que el pedido queda cerrado.`,
            'La conciliación solo mira nombres: el valor no se lee en ningún momento.',
            '', `Corrida: ${runUrl(context)}`,
        ].join('\n') });
        await github.rest.issues.addLabels({ ...repo, issue_number: issue.number, labels: [REGISTERED_LABEL] });
        await github.rest.issues.removeLabel({ ...repo, issue_number: issue.number, name: PENDING_LABEL });
        await github.rest.issues.update({ ...repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
        cerrados.push(nombre);
    }

    // Lo que está en la bóveda sin ningún pedido detrás: acá el control es detectivo, no preventivo.
    const conPedido = new Set([...pendientes, ...registrados].map(secretName));
    const huerfanos = [...enBoveda].filter((nombre) => !conPedido.has(nombre));

    const resumen = [
        '## Conciliación de la bóveda', '',
        `| Secretos en la bóveda | ${enBoveda.size} |`, '|---|---|',
        `| Pedidos cerrados ahora | ${cerrados.length} |`,
        `| **Sin pedido que los respalde** | **${huerfanos.length}** |`, '',
        ...(huerfanos.length
            ? ['### ⚠️ Secretos sin pedido aprobado', '',
               ...huerfanos.map((n) => `- \`${n}\``), '',
               'Alguien los cargó sin pasar por el flujo. Hay que revisar quién y por qué.']
            : ['Todo lo que hay en la bóveda tiene un pedido aprobado detrás.']),
    ].join('\n');

    await core.summary.addRaw(resumen).write();
    if (huerfanos.length) core.setFailed(`${huerfanos.length} secreto(s) sin pedido aprobado.`);
};
