# config/ —— 本机配置目录

把 [`def_config/config.yaml`](../def_config/config.yaml) 复制到这里命名为 `config.yaml`，
再改你要改的项即可（没写的键自动沿用 `def_config` 里的默认值）。

- 加载优先级：**环境变量 > `config/config.yaml` > `def_config/config.yaml`**。
- 本目录下的 `*.yaml` 已被 `.gitignore` 忽略：改动不入库，`git pull` 也不会覆盖你的部署配置。
- 改完需**重启服务器**生效。
