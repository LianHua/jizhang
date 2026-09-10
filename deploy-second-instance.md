# 在飞牛 NAS 上用「新增项目」再部署一个「空白」记账实例（第二实例）

> 适用场景：你已经有跑着的记账（`http://NAS_IP:9600`，容器名 `jizhang`），
> 现在想用**飞牛 Docker → Compose → 新增项目**的方式，另起一个**全新的、空的**实例，且**不影响老实例**。

---

## 0. 先看结论：4 个必须改的地方

两个实例共用**同一个镜像**，靠下面 4 项彻底隔离。**任何一项漏改都会出问题**：

| # | 项目 | 现有实例 | 第二实例 | 漏改的后果 |
|---|---|---|---|---|
| 1 | `container_name` | `jizhang` | **`jizhang-blank`** | ⚠️ **最危险**：同名时 compose 认为容器已存在 → 直接接管/重建**你现有那个**，等于把老实例搞停 |
| 2 | 宿主端口 | `9600` | **`9601`** | 端口已被占用，直接起不来 |
| 3 | 数据目录 | `.../jizhang/data` | **新目录 `.../jizhang-blank/data`** | ⚠️ 若复用同一目录，两个容器同时写同一个 SQLite → **数据库损坏**，两边数据一起坏 |
| 4 | `JWT_SECRET` | 旧随机串 | **换一个全新的随机串** | 密钥相同 → 在 A 登录拿到的 token 能被 B 接受（越权、串号） |

> 其余（`TZ`、容器内 `PORT=9600`、`DATA_DIR=/app/data`）**保持不动**。
> 特别提醒：容器内端口不要改，只改**冒号左边**的宿主端口；镜像里的健康检查写死了容器内 `9600`。

---

## 1. 准备：先建一个独立目录

**文件管理** → 进入你的存储空间 → 找到你放现有实例的那个 docker 目录 → **新建文件夹** `jizhang-blank`
（和 `jizhang` 并列即可）

> **⚠️ 路径必须以你自己的真实目录为准，别照抄示例。** 飞牛上这个目录可能是 `Docker`（**大写**）也可能是 `docker`（小写），还分 `/vol1`、`/vol2`。
> **不确定就查**：Docker → 「容器」→ 点 `jizhang` → 看它的**挂载/存储位置**，那就是你需要跟着走的地方。
> 写错的后果：Docker 会按你写的宿主路径**新建一个目录**（例如凭空多出一个 `docker` 文件夹），数据就跑到那儿去了。
> 好消息：下面 compose 用的是**相对路径 `./data`**，数据只落在你选的项目目录里，所以只要目录选对，就不会跑偏。

---

## 2. 用「新增项目」创建（界面方式，推荐）

1. 打开飞牛「**Docker**」应用 → 左侧「**Compose**」
2. 右上角点「**新增项目**」
3. 按下面填写：

| 字段 | 填什么 |
|---|---|
| 项目名称 | `jizhang-blank`（只能小写字母、数字、`-` `_`，**别填中文**） |
| 路径 | 选第 1 步建好的目录（和现有实例并列的那个 `jizhang-blank`） |
| 来源 | 「**创建 docker-compose.yml**」（另一项是「选择 docker-compose.yml」，用于已有文件） |
| 创建项目后立即启动 | ✅ 勾上 |

4. 把下面的内容**整段粘贴**进代码框（**环境变量已内联，界面方式不需要 `.env`**）：

```yaml
services:
  jizhang-blank:
    image: h223492759/jizhang:v260910-1804
    container_name: jizhang-blank
    restart: unless-stopped

    ports:
      - "9601:9600"

    environment:
      TZ: Asia/Shanghai
      PORT: 9600
      DATA_DIR: /app/data

      # ↓↓↓ 必须换成你自己的值 ↓↓↓
      JWT_SECRET: "粘贴一个 32 位以上的全新随机串"
      ADMIN_USERNAME: "lhj"
      ADMIN_PASSWORD: "给这个新实例设的强密码"
      ALLOW_REGISTER: "false"

    volumes:
      - ./data:/app/data    # 相对路径：数据落在你选的项目目录下，不会另建目录、不受大小写影响

    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9600/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

5. 点「**确定 / 创建**」→ 等状态变成 **running / healthy**。

> 若界面提示「缺少 version」之类的校验错误，在首行加一行 `version: "3.8"` 即可（compose v2 会忽略它，不影响运行）。
> 若粘贴后缩进被编辑器弄乱报语法错，改用界面里的「编辑」直接改文件，或先在文件管理里放好 `docker-compose.yml` 再用「来源 → 选择 docker-compose.yml」。

### 四个必须注意的点

- **`JWT_SECRET` 一定要换**：不要和老实例相同，也不要留默认值。
  生成方式：飞牛「终端 / SSH」执行 `openssl rand -hex 32` 复制结果；
  不想开终端也行 —— **随手敲 40 来个无规律字符**即可（它只用于签发登录 token）。
- **`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在「首次启动、库还是空的时候」生效**。想改账号密码得进「用户管理」，或删掉 `data` 目录重建。
- **端口用 `9601`**。若被占用，换 `9602`/`9603` —— 只改**冒号左边**。
- **`volumes` 保持相对路径 `./data`，别改成绝对路径**。写成 `/vol1/1000/docker/...` 这类绝对路径时，Docker 会**按字面新建**该宿主目录 —— 飞牛的共享文件夹是 `Docker`（大写）而路径写成 `docker`（小写）就会凭空多出一个新目录，数据也跟着过去。（这正是上一版文档踩的坑。）

### 如果你更想用 `.env`（可选）

界面方式不会帮你创建 `.env`。做法：先按上面建好项目 → 用**文件管理**把 `.env` 放进你选的那个项目目录 → 再回 Compose 里对该项目点「**重新部署**」。
（`.env` 内容：`JWT_SECRET=...` / `ADMIN_USERNAME=...` / `ADMIN_PASSWORD=...`，compose 里对应的值写成 `${JWT_SECRET}` 形式。**内联方式更省事，推荐内联。**）

---

## 3. 验证（别跳过）

**看容器**：Docker → 「容器」，应同时有两个：

| 名称 | 端口 | 状态 |
|---|---|---|
| `jizhang` | `0.0.0.0:9600->9600/tcp` | 健康 ✅ → **老实例没被动** |
| `jizhang-blank` | `0.0.0.0:9601->9600/tcp` | 健康 ✅ → 新实例 |

**看日志**：Docker → 容器 → `jizhang-blank` → 「运行日志」，应有：

```
[init] 已创建默认管理员账号：<你的账号> / <你的密码>
Jizhang 服务已启动: http://0.0.0.0:9600
```

**访问**：浏览器打开 `http://你的NAS内网IP:9601` → 用 `.env`/内联里的新账号登录 →
应看到**完全空白的新账本**（0 笔流水、默认分类齐全），而 `:9600` 那边数据原样不变。

（有 SSH 的话也可以直接 `curl -s http://127.0.0.1:9601/api/health` 期望 `{"ok":true,...}`。）

---

## 4. 第二实例的日常运维

界面：Docker → Compose → 找到 `jizhang-blank` → 「启动 / 停止 / 重新部署 / 编辑 / 删除」。

SSH / 终端：

```bash
cd <你选的那个项目目录>          # 例：/vol1/1000/Docker/jizhang-blank

docker compose logs -f                          # 看日志
docker compose restart                          # 重启
docker compose stop                             # 停（数据保留）
docker compose down                             # 删容器（./data 里的数据不丢）
docker compose pull && docker compose up -d     # 升级到最新镜像
docker compose down && rm -rf data              # ⚠️ 彻底清空重来（会删掉这个实例的数据！）
```

- **数据位置**：`<你选的项目目录>/data/jizhang.db`
- **备份**：`docker compose stop && cp -r data ~/jizhang-blank-backup-$(date +%Y%m%d) && docker compose start`
- 两个实例的**数据、备份、升级完全独立**，互不影响。

---

## 5. 常见坑

| 现象 | 原因 / 解决 |
|---|---|
| 新增项目里路径选不了 / 列表里没有 | 目录要先在**文件管理**里建好，界面只能选已存在的目录 |
| `Error: port is already allocated` 或起不来 | 宿主 9601 被别的服务占了 → 换成 9602/9603（只改冒号左边） |
| 老实例被重启/重建了 | `container_name` 忘改，两个项目都叫 `jizhang` → 立刻改掉，别重复执行 |
| 新实例打开后看到的是老数据 | `volumes` 指向了老实例的 `data` 目录 → 改成新目录，**并把新实例的 data 目录清空重建** |
| 登录后提示 token 无效 / 串号 | 两个实例 `JWT_SECRET` 相同 → 给第二实例换一个全新随机串，重新部署 |
| 想改管理员账号密码，改了 compose 没反应 | 账号只在空库首次启动时创建 → 进「用户管理」改，或清空 `data` 重建 |
| 拉镜像超时 | 镜像源问题（与现有实例同一套设置，能拉就不影响） |
| 凭空多出一个 `docker` / `Docker` 目录 | `volumes` 写了绝对路径且大小写/盘符与实际不符 → 见下面「已经跑偏了怎么办」 |
| 手机端数据混了 | 两套库 → App/浏览器要分别用 `:9600` 和 `:9601`，别当成同一个地址 |

### 已经跑偏了怎么办（`volumes` 写成绝对路径、数据落到新目录）

**先别删任何东西。** 数据本身没坏，SQLite 就是一个文件，搬过去就行：

1. **确认真实目录**：Docker → 容器 → 点 `jizhang` → 看挂载位置（例如其实是 `/vol1/1000/Docker/`，大写）。
2. **停新实例**：Docker → Compose → `jizhang-blank` → 停止。
3. 二选一：
   - **懒得搬** —— 就用现在这个位置：把界面项目里的 `volumes` 改成 `./data:/app/data`（改成相对路径，以后不会再看天吃饭），然后把那个多余的空目录删掉即可。
   - **搬到正确目录** —— 在正确位置建好 `jizhang-blank` → 把现在 `data` 整个目录**移动**过去 → 界面把项目路径改到新位置（或删掉项目重建，来源选「选择 docker-compose.yml」）→ 启动。
4. 确认新位置里 `data/jizhang.db` 已就位、实例能正常打开后，**再**删那个多余的目录（删前确认里面只剩空壳，没有 `data`）。

> ⚠️ 搬动时务必**先停容器**，且整目录搬（`data` 里有 `.db-wal` / `.db-shm`，只拷 `.db` 会得到损坏副本）。

---

## 6. 一句话总结

**同一个镜像、不同的容器名 + 不同的宿主端口 + 不同的空 data 目录 + 不同的 JWT 密钥 = 一个完全隔离的空白新实例。**
四项缺一不可，其中 `container_name` 和 `data` 目录弄错会直接伤到现有实例。

> 这个新实例的「首次空库启动」正是已做过 71 项断言验证、且进了 CI 冒烟闸门的路径，起得来是验证过的。
> 想要可复现/可回滚，`image` 就不写 `latest`，写固定 tag（如 `v260910-1804`）。
