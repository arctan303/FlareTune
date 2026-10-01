# Google 登录

Google 登录是可选功能，默认关闭。它绑定已有 FlareTune 账号，不自动注册或按邮箱合并，不改变角色或个人数据。本地密码登录仍可用，首次初始化仍须设置密码。

## 管理员配置

1. 既有实例先在「设置 → 实例设置 → 运行概况」升级数据库。新安装已包含所需表。
2. 在 Google Cloud 配置 **Web application** OAuth 客户端和授权界面。可使用已有 Google Cloud 项目；Client ID、Secret 和回调必须属于同一 Web 客户端。测试状态按 Google 控制台要求添加测试用户。
3. 在「实例设置 → Google 登录」填写 Client ID、Client Secret、固定回调来源，例如 `https://music.example.com`。来源只有协议、域名和端口，不加路径或末尾斜杠。
4. 将显示的完整地址加入 Google 控制台 **Authorized redirect URIs**：`https://music.example.com/auth/google/callback`。登录和绑定共用此地址，必须精确匹配。
5. 启用并保存。在该来源的登录页应看到「使用 Google 登录」；其他来源不显示入口。

生产须用 HTTPS；本地可用 `http://127.0.0.1:8790` 等固定来源。请直接打开与回调来源一致的 Worker 站点；代理前端到另一来源时，浏览器事务 Cookie 属于代理地址，不能完成另一站点的回调。开发和生产实例分别配置。

Secret 仅在服务端加密保存、不回显；留空保留原密钥，更换 Client ID 须同时录入对应 Secret。轮换 `SETUP_SECRET` 后须重新输入 Google Secret，本地密码登录不受影响。关闭入口保留绑定；凭据仍可用时用户仍可管理绑定。

## 用户操作

1. 首次用 FlareTune 用户名与密码登录，完成要求的改密。
2. 在「个人设置 → Google 登录」点击「绑定 Google」，验证当前本站密码后选择 Google 账号。
3. 绑定后可点击 Google 登录免输本站密码；Google 仍可能要求选账号、授权或验证身份。

一个 Google 账号只能绑定一个本站账号。尚未绑定、停用或必须改密的账号不能通过 Google 登录。解绑须验证本站密码，并退出该本站账号的所有设备；歌单、收藏与收听数据保留。更换 Google 账号时先解绑再绑定。

## 失败处理

- 回调不匹配：核对实际来源及 Google 控制台完整回调地址。
- 无入口：核对开关、数据库升级、Client ID/Secret、解密状态和当前来源。
- 已过期或失败：在当前浏览器重新发起，不复制其他浏览器回调地址。多标签页同时授权时，只保证最新浏览器事务可完成。
- 尚未绑定：先使用本站密码登录并绑定，相同邮箱不会自动绑定。
- 绑定失败：检查是否已绑定其他账号，以及本站会话与密码验证是否仍有效。

改密、账号停用状态变化或绑定增删会取消实例内未完成的 Google 登录；其他账号已建立的会话不受此影响。Google 配置变化也会令未完成事务失效。错误不显示 Token 或 Secret。

协议依据：[Google Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)、[OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)。真实授权须在正确配置的实例中验收，本地模拟回归不能代替该步骤。
