# Sistema Afisco — versão corrigida

Esta versão usa o Neon como fonte de verdade. Cadastros e pagamentos só aparecem na tela depois que o banco confirma o salvamento.

## O que foi corrigido

- rotas de criação, edição e exclusão compatíveis com as funções do Vercel;
- nomes dos campos compatíveis entre a página e o PostgreSQL/Neon;
- criação automática das mensalidades ao abrir um período;
- criação da mensalidade atual ao cadastrar um cliente ativo;
- atualização automática de títulos vencidos;
- indicador de conexão com o Neon;
- total de meses pagos por cliente dentro de **Mensalidades** e da ficha do cliente;
- mensalidade/recibo imprimível ao clicar no cliente, preenchido automaticamente com os dados do Neon;
- novo logo da Afisco no sistema e no documento de impressão;
- login individual com sessão segura e senha armazenada por hash;
- Hélio como administrador com acesso completo;
- funcionários limitados no servidor aos clientes vinculados ao próprio nome de responsável;
- painel de funcionários para criar, desativar e redefinir senhas;
- o seletor de mês/ano saiu do topo e ficou dentro de **Mensalidades**;
- o arquivo inicial agora se chama corretamente `index.html`.

## Publicar no GitHub e Vercel

1. Substitua os arquivos do repositório pelos desta pasta. Não envie `node_modules` nem `.env.local`.
2. No Vercel, abra **Settings → Environment Variables** e confirme que existe a variável `DATABASE_URL` com a conexão do Neon.
3. Adicione também `AFISCO_ADMIN_NAME` com valor `Helio`, `AFISCO_ADMIN_USER` com o usuário escolhido para Hélio e `AFISCO_ADMIN_PASSWORD` com uma senha forte de pelo menos 8 caracteres.
4. Marque as variáveis para **Production** e **Preview** e faça um novo deploy.

No primeiro acesso, o sistema cria Hélio como administrador. Depois, Hélio usa a aba **Funcionários** para cadastrar Harrisson e Nando. Em **Responsável pelos clientes**, use exatamente `Harrisson` ou `Nando`, conforme estiver escrito nos cadastros dos clientes.

As tabelas `clientes` e `mensalidades` são criadas automaticamente caso ainda não existam. A aplicação não inclui dados de demonstração, para não misturá-los com os dados reais do escritório.
