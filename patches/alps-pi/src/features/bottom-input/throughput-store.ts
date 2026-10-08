/** 功能：把最近一次实测吞吐率持久化到 agent 目录，使 » tok/s 指标在 /reload 与重启后依然常驻。 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSettingsPath } from "../../settings-store.ts";

/** 状态文件与 alps-pi 设置同目录：<agentDir>/alps-pi/throughput.json */
function storePath(): string {
	return join(dirname(getSettingsPath()), "alps-pi", "throughput.json");
}

/** 读取上次持久化的吞吐率；文件缺失、损坏或数值非法时返回 null。 */
export function readStoredThroughput(): number | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(storePath(), "utf-8"));
		const rate = Number((parsed as { tokensPerSecond?: unknown } | null)?.tokensPerSecond);
		return Number.isFinite(rate) && rate > 0 ? rate : null;
	} catch {
		return null;
	}
}

/** 持久化最新吞吐率；失败时静默降级，仅影响跨进程常驻。 */
export function writeStoredThroughput(rate: number): void {
	if (!Number.isFinite(rate) || rate <= 0) return;
	try {
		const path = storePath();
		mkdirSync(dirname(path), { recursive: true });
		const payload = {
			tokensPerSecond: Number(rate.toFixed(2)),
			updatedAt: new Date().toISOString(),
		};
		writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	} catch {
		// 状态文件不可写时忽略：吞吐率退化回“仅当前进程有效”。
	}
}
