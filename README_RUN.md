# 本地开发

源码开发支持 Node.js 22.22.0 至 26.x。以下命令适用于 Node.js 26.12.1 和 pnpm 11.5.3。

## 启动后端

在仓库根目录打开一个终端。

```sh
cd backend-node
pnpm install
pnpm run dev
```

后端默认监听 `http://localhost:5680`，可通过 `/health` 检查运行状态。

## 启动前端

从仓库根目录另开一个终端。

```sh
cd frontweb
pnpm install
pnpm run dev
```

打开 `http://localhost:3013` 使用开发环境。
