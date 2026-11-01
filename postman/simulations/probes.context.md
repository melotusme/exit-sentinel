# probes · local verification context

2026-10-28：Postman CLI 1.74.0；本地配置生成的 mock，无云发布。没有可信的上游团队 mock，使用项目中 `probe-contract.yaml` 的响应形状生成。

- 启动：`rtk proxy postman simulation run postman/simulations/probes.sim.yaml --port 14920 --output ndjson`。
- 验证：`rtk proxy env SENTINEL_SIM_URL=http://127.0.0.1:14920/probes node scripts/rust.mjs test postman_simulation -- --ignored --nocapture`。
- 日志的 listening URL 是真实绑定地址；Rust 客户端必须包含 `/probes` 路由前缀。
- 真实 Rust `run_probe` 发送了五次 GET：`/json`、`/trace`、`/ipip`、`/challenge`、`/limited`，全部在 request 日志中出现。前三者识别对应公网 IP；HTML 验证页和 HTTP 429 返回失败。
- 结果：模拟集成测试通过。唯一成员 probes 被实际调用，无未调用成员。
- 此验证不证明真实站点可用、账号资格或 macOS 通知展示。额外普通 Rust 测试覆盖不可达连接、私网/Fake-IP 拒绝、连续两次确认和失败恢复。真实只读端点测试另行执行。
