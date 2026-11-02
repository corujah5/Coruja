# CORUJA TIME — Deploy online

Projeto Node.js + Express preparado para publicação no Render.

## Segurança
- O arquivo `.env` real foi removido deste pacote.
- Não envie tokens ou senhas para o GitHub.
- Configure `TMDB_TOKEN` e `ADMIN_USERNAME` nas variáveis de ambiente do serviço.
- `ADMIN_USERNAME` deve corresponder ao nome de usuário da conta administradora; as rotas administrativas exigem a sessão autenticada dessa conta.
- Para o primeiro provisionamento em um disco vazio, configure temporariamente `ADMIN_BOOTSTRAP_SECRET` com pelo menos 32 bytes aleatórios. Antes do primeiro deploy, configure também `ADMIN_USERNAME` com o usuário que será criado. Envie uma única requisição `POST /api/bootstrap/admin` pelo HTTPS com o segredo no cabeçalho `x-admin-bootstrap` e `name`, `username` e `password` no corpo JSON. O usuário precisa corresponder a `ADMIN_USERNAME`.
- Depois da resposta de sucesso, remova `ADMIN_BOOTSTRAP_SECRET` no painel do Render e reinicie/reimplante o serviço. O marcador persistente `admin-bootstrap.json` no disco impede novo uso mesmo após reinícios; a rota também falha fechada se já houver usuários ou se `users.json` estiver inválido. O bootstrap não aparece no frontend e não habilita cadastro público.
- Após reiniciar, entre com a nova conta. A identificação administrativa por `ADMIN_USERNAME` é resolvida na inicialização do servidor.
- Dados de usuários e sessões ficam fora do repositório e, no Render, no disco persistente `/var/data`.

Não coloque o segredo temporário, a senha ou arquivos privados de dados no Git. Use um cliente HTTPS que mantenha os valores fora do histórico do terminal e não compartilhe o cabeçalho em logs ou capturas. Se o provisionamento falhar antes de criar a conta, corrija a configuração e só então tente novamente; depois de concluído, o marcador no disco mantém o bootstrap consumido.

## Deploy
Build:
`npm install --no-audit --no-fund`

Start:
`npm start`

O `render.yaml` já está preparado para o serviço web e o disco persistente.
