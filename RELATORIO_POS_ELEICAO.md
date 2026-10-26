# Relatório — atualização pós-eleição do Painel de Apuração

## Resumo

A camada pós-eleição foi integrada de forma aditiva. O palco original, o motor ao vivo, as rotas de API, o CSS visual original e a CSP foram preservados. A nova área é isolada em `pos.js`/`pos.css` e degrada para estados vazios quando os arquivos de dados ainda não foram gerados ou não passam nas validações.

**Limitação importante desta entrega:** não foi possível consultar fontes externas a partir deste ambiente. Por isso, o ZIP contém os scripts e a estrutura para criar snapshots e malhas reais, mas **não contém resultados finais, geometria municipal nem série horária inventados**. A camada de análise permanece sem números até os arquivos oficiais serem obtidos e validados. Os itens da seção 6 do prompt que dependem de verificação ao vivo permanecem pendentes; não devem ser tratados como confirmados.

## Arquivos novos

- `public/pos.js` — interface pós-eleição, gráficos e tabelas acessíveis, mapa municipal sob demanda, ranking/busca, zoom/pan, diálogo de boletim, compartilhamento explícito e geração local de PNG.
- `public/pos.css` — estilos novos, responsivos e prefixados, reaproveitando tokens do projeto.
- `public/pos-core.mjs` — funções puras de formatação, validação numérica, correspondência e cálculo das séries horárias.
- `public/data/final/manifest.json` — marcador inicial de snapshot ainda não gerado.
- `public/data/horarios.json` — esquema vazio, com a semântica declarada como `totalizacao` e janela ainda não verificada.
- `public/data/municipios-map.json` — tabela TSE↔IBGE explicitamente vazia/incompleta.
- `scripts/build-snapshot.js` — coleta e valida arquivos TSE, registra fontes/carimbos, faz sondagem de possíveis URLs municipais em build e evita declarar conjunto parcial como completo.
- `scripts/build-municipios.js` — empacotamento da malha por UF, simplificação da geometria e relatório de cobertura da correspondência.
- `scripts/build-horarios.js` — valida e instala somente uma série horária real fornecida por arquivo.
- `scripts/test-pos-core.mjs` — testes puros sem framework.
- `RELATORIO_POS_ELEICAO.md` — este relatório.

## Arquivos existentes alterados

- `public/index.html`: adicionados somente o link para `pos.css` e o script `pos.js`.
- `public/sw.js`: versão de cache incrementada para `v8-2026-10-26-pos-eleicao`; novos arquivos locais incluídos no shell; `/data/` usa rede-primeiro com fallback ao cache; `/api/*` continua fora do cache.
- `server.js`: adicionado MIME para `.mjs`.
- `package.json`: scripts de teste e build adicionados.

**Diff pontual:** o arquivo complementar `DIFF_POS_ELEICAO.patch` contém o diff exato dos quatro arquivos existentes alterados (`public/index.html`, `public/sw.js`, `server.js` e `package.json`).

**Conferência de preservação:** `public/app.js`, `public/styles.css`, `public/uf-paths.js`, `vercel.json` e os três arquivos de API estão byte a byte iguais aos do ZIP recebido. A CSP não foi afrouxada e nenhuma dependência de runtime foi adicionada.

## Funcionalidades incluídas na camada nova

- Gráficos de resultado, composição do eleitorado, margens por UF, regiões, comparecimento/abstenção e resumo de municípios quando houver dados válidos.
- Análise horária que distingue `votos apurados/divulgados` de `horário da votação`, com faixas configuráveis, destaque 17h–19h, série hora a hora, acumulado, margem, seções e ritmo. O primeiro ponto acumulado é tratado como referência, não como votos novos.
- Boletim com escolhas explícitas, prévia, texto, links de compartilhamento, cópia de link e PNG gerado no navegador. Não há publicação ou envio automático.
- Vista municipal com carregamento local por UF, busca sem sensibilidade a acentos, ranking, cartão, suporte de teclado e zoom/pan; resultados sem correspondência ou sem totalização final ficam sem cor/dados.
- Verificação antes de mostrar resultado: snapshots só são liberados se o manifesto indicar `ready=true` e `complete=true`, e os totais passarem pela validação numérica.

Por segurança de compatibilidade, a vista municipal usa o parâmetro de consulta `?pos-cidades=UF`, em vez de adicionar segmentos ao hash da aplicação original, cujo roteador normaliza rotas desconhecidas. O `hash` existente foi preservado.

## Verificações executadas

- `npm test`: passou — formatação pt-BR, validação de totais, margem/empate, faixas e série horária, e cobertura da tabela de correspondência.
- `node --check`: passou para os módulos JavaScript e scripts de build.
- Smoke test HTTP local: `/`, `index.html`, `pos.js`, `pos-core.mjs`, `pos.css`, `sw.js`, `uf-paths.js` e os três JSON iniciais responderam HTTP 200.
- Comparação do ZIP original com a cópia de trabalho: os arquivos protegidos listados acima permaneceram inalterados.

Não foi possível fazer comparação visual pixel a pixel, capturas reais antes/depois ou teste interativo em navegador. A política do navegador deste ambiente bloqueou o acesso ao `localhost`; a imagem de erro foi excluída do pacote e não é apresentada como captura do aplicativo.

## Verificações de fonte ainda pendentes

Não foi possível confirmar em rede, nesta execução:

1. O padrão real de URLs/arquivos municipais do TSE para `6258` e `6260`.
2. A existência e viabilidade de dados oficiais sobre o horário em que cada eleitor votou, em contraste com a hora de totalização/divulgação.
3. A publicação e o formato oficial da correspondência de códigos municipais TSE↔IBGE.
4. A janela eleitoral oficial exata; 17h–19h permanece configurada como hipótese do pedido, não como fato verificado.
5. Os dados finais dos candidatos a governador e os números finais; a ordem do script espelha a configuração local existente, mas não foi validada externamente.

O script de snapshot inclui sondagem das URLs municipais em ambiente com rede e registra o padrão que efetivamente responder. Isso ainda precisa ser executado e revisado. A tabela TSE↔IBGE deve vir de fonte oficial e ser fornecida ao script; **não se assume equivalência entre códigos**.

## Como testar e preparar dados

Requer Node.js 18 ou superior.

```bash
npm test
npm start
```

Em ambiente autorizado com acesso às fontes oficiais:

```bash
node scripts/build-snapshot.js
```

Para tentar gerar também arquivos municipais, primeiro preencha uma tabela de correspondência oficial TSE↔IBGE (CSV/JSON no formato aceito pelo script) e só então execute:

```bash
node scripts/build-municipios.js --mapping-file caminho/municipios-map.csv --mapping-source "URL_HTTPS_OFICIAL_TSE_OU_IBGE"
node scripts/build-snapshot.js --municipalities
```

O script de série horária aceita somente arquivo real validado:

```bash
node scripts/build-horarios.js --input caminho/horarios.json
```

Revise `public/data/final/build-report.json`, `public/data/municipios-build-report.json` e as mensagens dos scripts. Não use `--allow-partial` para publicação: a interface bloqueia snapshots com manifesto incompleto, mas o argumento existe apenas para inspeção controlada. Depois de revisar os dados gerados, publique o projeto na Vercel pelo fluxo habitual (ou `vercel --prod`, se a CLI já estiver configurada). O Service Worker já está com nova versão; incremente `CACHE_VERSION` em cada novo deploy.

## Estado de entrega

A integração e os testes locais foram feitos, mas a validação final dos dados oficiais, o preenchimento do mapa municipal e a QA visual em navegador ainda precisam ocorrer em um ambiente com acesso a fontes oficiais e navegador de teste. Até lá, o aplicativo mantém a apuração original separada e exibe estados vazios honestos para a camada pós-eleição.
