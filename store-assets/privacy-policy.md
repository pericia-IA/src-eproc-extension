# Política de Privacidade — Extensão Perícia Hub

**Data de vigência:** 23 de julho de 2026

Esta Política de Privacidade descreve como a extensão de navegador **Perícia Hub** ("a Extensão") trata os dados durante seu uso. A Extensão destina-se exclusivamente a médicos peritos que atuam no sistema e-proc do TRF6 e utilizam o sistema Perícia Hub para a elaboração de laudos médicos periciais.

## 1. Quais dados a Extensão acessa

Durante o uso, a Extensão pode acessar:

- **Conteúdo de páginas do e-proc (TRF6):** o texto do formulário de Laudo Médico Pericial e documentos do processo judicial em análise, que podem conter **dados pessoais e dados de saúde** das partes do processo;
- **Documentos médicos enviados pelo usuário:** imagens ou PDFs de documentos médicos (atestados, exames, receitas) enviados pelo próprio perito para transcrição, pelo computador ou pelo celular (via QR code);
- **Resultados gerados pelo sistema Perícia Hub:** os textos processados que serão preenchidos no formulário do laudo.

A Extensão **não** acessa histórico de navegação, dados de outros sites, senhas ou credenciais.

## 2. Para que os dados são usados

Os dados são usados para uma **única finalidade**: auxiliar o perito no preenchimento do formulário de Laudo Médico Pericial no e-proc TRF6 — incluindo a extração de informações do processo, a resposta a quesitos, o refinamento de textos e a transcrição de documentos médicos.

Os dados **não** são usados para publicidade, criação de perfis, análise de crédito ou qualquer finalidade não relacionada à elaboração do laudo.

## 3. Para onde os dados são enviados

Para realizar o processamento, a Extensão envia o texto do processo e os documentos ao **servidor do Perícia Hub**, que por sua vez utiliza serviços de inteligência artificial (API da Anthropic) e de reconhecimento óptico de caracteres (Microsoft Azure) estritamente para gerar os textos do laudo.

- O servidor do Perícia Hub **não armazena de forma permanente** o conteúdo dos processos ou documentos: os dados são processados em memória e descartados ao final de cada requisição (no fluxo de envio pelo celular, o resultado é mantido em memória por no máximo alguns minutos, apenas até ser entregue ao computador do perito).
- Os dados **não são vendidos** nem compartilhados com terceiros para outras finalidades.

## 4. Armazenamento local no navegador

A Extensão utiliza o armazenamento local do navegador (`chrome.storage.local`) apenas para guardar, temporariamente e no próprio computador do usuário, os dados do laudo gerados no sistema Perícia Hub até que sejam preenchidos na página do e-proc. Esses dados permanecem no dispositivo do usuário e podem ser removidos desinstalando a Extensão.

## 5. Base legal e LGPD

O tratamento de dados descrito nesta política ocorre no contexto do exercício da atividade de perícia médica judicial, conduzida pelo próprio perito usuário da Extensão, em conformidade com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018). O perito, na qualidade de usuário, permanece responsável pelo sigilo profissional e pelo uso adequado das informações dos processos sob sua responsabilidade.

## 6. Segurança

Toda a comunicação entre a Extensão, o sistema Perícia Hub e o e-proc ocorre por conexões criptografadas (HTTPS). O acesso ao e-proc utiliza exclusivamente a sessão já autenticada do próprio usuário — a Extensão não coleta nem armazena credenciais.

## 7. Alterações a esta política

Esta política pode ser atualizada. Alterações relevantes serão refletidas nesta página, com atualização da data de vigência.

## 8. Contato

Para dúvidas, solicitações de acesso ou exclusão de dados relacionadas à Extensão, entre em contato: **pericia.ia.corp@outlook.com**
