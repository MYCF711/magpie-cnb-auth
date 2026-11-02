// examples/split/src/hooks/config.mjs —— ① 声明 provider
//
// 这一类钩子是**纯声明**：不网络、不算数、只把形状交给宿主。同类的还有
// `chat.headers`（照请求加头）。搬的时候整段抄过来，把 `c.XXX` 换成自己的常量即可。

export function makeConfig(c) {
  return async (cfg) => {
    cfg.provider ??= {}
    // ⚠ 用 ??= ，不要覆盖用户在 plugins.json 里配的（覆盖 = 用户改过的配置被静默吃掉）
    cfg.provider[c.PROVIDER] ??= {
      name: c.PROVIDER_NAME,
      npm: c.SDK,
      api: c.BASE,
      // ⚠ 未登录时也必须有内容 —— 空表 = 卡片显示 0 models，用户以为插件坏了
      models: c.staticModels(),
    }
  }
}
