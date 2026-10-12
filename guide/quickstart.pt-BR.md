# Guia rápido do FlareTune

[Experimente a demonstração sem entrar](https://flaretune.arcinks.com) · [Recursos e licenças (inglês)](demo.en.md). Explore todas as configurações como administrador e altere preferências locais. Envie mensagens ao assistente e receba uma resposta fixa de demonstração, sem chamadas a modelos.

[Português (Brasil)](quickstart.pt-BR.md) · [English](../README.en.md) · [简体中文](../README.md)

Sua biblioteca de música privada no Cloudflare, sem manter um VPS. O aplicativo usa Workers, os metadados ficam no D1 e o áudio e as capas ficam no R2 privado. O R2 Standard inclui 10 GB-month gratuitos por mês. O uso total da conta, as solicitações e os serviços opcionais podem gerar cobranças: veja [custos e limites em inglês](deployment.en.md).

Experimente a [demo sem login](demo.en.md): reproduza, pesquise, favorite músicas e edite listas. Os dados pessoais ficam neste navegador.

1. Ative o R2 na sua conta Cloudflare e crie recursos próprios com [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune).
2. Defina e guarde com segurança um `SETUP_SECRET` aleatório com pelo menos 32 caracteres.
3. Abra o endereço da implantação, confirme o segredo, crie o primeiro administrador e entre.
4. Importe músicas que você tem direito de usar. Para muitos arquivos, use o [dispositivo de importação local em inglês](../tooling/ingest-agent/README.en.md).

Escolha Português (Brasil) nas configurações pessoais. Na instância normal, favoritos e listas são salvos na conta; o histórico de reprodução fica no navegador atual. A IA é opcional. Antes de atualizar, faça backup do D1 e do R2; não sobrescreva uma instância existente com a inicialização de uma instalação nova.

Guias completos em inglês: [Uso](using-flaretune.en.md) · [Implantação](deployment.en.md) · [Administração](administration.en.md) · [Subsonic](subsonic.en.md).
