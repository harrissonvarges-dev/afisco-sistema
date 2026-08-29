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
- o seletor de mês/ano saiu do topo e ficou dentro de **Mensalidades**;
- o arquivo inicial agora se chama corretamente `index.html`.

## Publicar no GitHub e Vercel

1. Substitua os arquivos do repositório pelos desta pasta. Não envie `node_modules` nem `.env.local`.
2. No Vercel, abra **Settings → Environment Variables** e confirme que existe a variável `DATABASE_URL` com a conexão do Neon.
3. Marque a variável para **Production**, **Preview** e **Development** e faça um novo deploy.

As tabelas `clientes` e `mensalidades` são criadas automaticamente caso ainda não existam. A aplicação não inclui dados de demonstração, para não misturá-los com os dados reais do escritório.
