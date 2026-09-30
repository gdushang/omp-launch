// omp-launch: arrow-key settings panel — SettingsList menu with SelectList submenus.
import { basename } from "node:path";
import {
	getSelectListTheme,
	getSettingsListTheme,
	SelectList,
	SettingsList,
	type Component,
	type SelectItem,
	type SettingItem,
} from "@oh-my-pi/pi-tui";
import { availableMedia, userLaunchDir, type FitMode, type LaunchConfig, type ProtocolMode } from "./config";

/** Host wiring: persistence and playback stay in index.ts, the panel only drives them. */
export interface SettingsHost {
	config: LaunchConfig;
	/** Merge a patch into the launch.json the current config came from. */
	save: (patch: Record<string, unknown>) => void;
	/** Play one video once, without touching the default. */
	preview: (target: string) => void;
	/** The default video changed: check its pre-encoded cache and build it when missing. */
	defaultChanged: (target: string) => void;
	/** A change that alters the cache key (fit / fps / maxPixels / resizeWindow / protocol). */
	cacheInvalidated: (field: string) => void;
	/** Delete the stored sequences; the next start encodes them again. */
	clearCache: () => void;
	/** Value shown on the "默认动画" row. */
	defaultLabel: string;
	/** Value shown on the "清理预编码" row, e.g. "1 个文件 · 334MB". */
	cacheLabel: string;
}

interface Choice<T> {
	label: string;
	value: T;
}

const FIT_CHOICES: ReadonlyArray<Choice<FitMode>> = [
	{ label: "保持宽高比", value: "contain" },
	{ label: "居中", value: "contain-center" },
	{ label: "方向裁剪", value: "cover" },
];

const PROTOCOL_CHOICES: ReadonlyArray<Choice<ProtocolMode>> = [
	{ label: "自动", value: "auto" },
	{ label: "SIXEL", value: "sixel" },
	{ label: "彩色块", value: "blocks" },
];

const FPS_CHOICES: ReadonlyArray<Choice<number>> = [
	{ label: "跟随源", value: 0 },
	{ label: "60", value: 60 },
	{ label: "30", value: 30 },
	{ label: "24", value: 24 },
	{ label: "12", value: 12 },
];

const MAX_PIXELS_CHOICES: ReadonlyArray<Choice<number>> = [
	{ label: "跟随窗口", value: 0 },
	{ label: "1080p", value: 2_073_600 },
	{ label: "720p", value: 921_600 },
	{ label: "480p", value: 409_920 },
];

const BUDGET_CHOICES: ReadonlyArray<Choice<number>> = [
	{ label: "256 MB", value: 256 },
	{ label: "128 MB", value: 128 },
	{ label: "512 MB", value: 512 },
	{ label: "64 MB", value: 64 },
];

const LOOP_CHOICES: ReadonlyArray<Choice<number>> = [
	{ label: "1 次", value: 1 },
	{ label: "2 次", value: 2 },
	{ label: "3 次", value: 3 },
];

const ON_OFF: ReadonlyArray<Choice<boolean>> = [
	{ label: "开", value: true },
	{ label: "关", value: false },
];

function labelOf<T>(choices: ReadonlyArray<Choice<T>>, value: T): string {
	return choices.find(choice => choice.value === value)?.label ?? String(value);
}

function valueOf<T>(choices: ReadonlyArray<Choice<T>>, label: string): T | undefined {
	return choices.find(choice => choice.label === label)?.value;
}

/** A SelectList over `choices`, pre-marking `current`; Esc closes it. */
function choiceMenu<T>(
	choices: ReadonlyArray<Choice<T>>,
	current: T | undefined,
	onPick: (value: T) => void,
	onCancel: () => void,
): SelectList {
	const items: SelectItem[] = choices.map(choice => ({
		value: choice.label,
		label: choice.label,
		description: choice.value === current ? "当前" : undefined,
	}));
	const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
	list.onSelect = item => {
		const picked = valueOf(choices, item.value);
		if (picked !== undefined) onPick(picked);
	};
	list.onCancel = onCancel;
	return list;
}

/** Videos the user can pick: everything in the config directory, plus the current file. */
function animationChoices(config: LaunchConfig): SelectItem[] {
	const items: SelectItem[] = availableMedia(config.dir ?? userLaunchDir()).map(path => ({
		value: path,
		label: basename(path),
	}));
	const active = config.mediaPath;
	if (active && !items.some(item => item.value === active)) {
		items.unshift({ value: active, label: `当前素材 ${basename(active)}` });
	}
	// An empty SelectList is a dead end; say why there is nothing to pick.
	if (items.length === 0) items.push({ value: "", label: "（配置目录里没有视频文件）" });
	return items;
}

/** A SelectList over the available videos; Esc closes it. */
function animationMenu(
	config: LaunchConfig,
	onPick: (target: string) => void,
	onCancel: () => void,
): SelectList {
	const items = animationChoices(config);
	const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
	list.onSelect = item => onPick(item.value);
	list.onCancel = onCancel;
	return list;
}

/** Round-trip a menu label back into the value that belongs in launch.json. */
function applyChange(host: SettingsHost, id: string, label: string): void {
	switch (id) {
		case "default":
			// The picked value is a file path; the placeholder row carries none.
			if (label.length === 0) return;
			// An explicit source outranks `auto`, so it is written as-is.
			host.save({ source: label });
			host.defaultChanged(label);
			return;
		case "fit":
			host.save({ fit: valueOf(FIT_CHOICES, label) });
			host.cacheInvalidated("裁剪方式");
			return;
		case "protocol":
			host.save({ protocol: valueOf(PROTOCOL_CHOICES, label) });
			host.cacheInvalidated("渲染协议");
			return;
		case "fps":
			host.save({ fps: valueOf(FPS_CHOICES, label) });
			host.cacheInvalidated("帧率上限");
			return;
		case "maxPixels":
			host.save({ maxPixels: valueOf(MAX_PIXELS_CHOICES, label) });
			host.cacheInvalidated("单帧像素上限");
			return;
		case "frameBudget":
			host.save({ frameBudgetMb: valueOf(BUDGET_CHOICES, label) });
			return;
		case "loop":
			host.save({ loop: valueOf(LOOP_CHOICES, label) });
			return;
		case "resizeWindow":
			host.save({ resizeWindow: valueOf(ON_OFF, label) });
			host.cacheInvalidated("播放时最大化窗口");
			return;
		case "allowSkip":
			host.save({ allowSkip: valueOf(ON_OFF, label) });
			return;
		case "takeover":
			host.save({ takeover: valueOf(ON_OFF, label) });
	}
}

function buildItems(host: SettingsHost, refresh: () => void): SettingItem[] {
	const { config } = host;
	return [
		{ id: "heading-media", label: "素材", heading: true, currentValue: "" },
		{
			id: "default",
			label: "默认素材",
			description: "启动时播哪一个视频（配置目录里的文件），写入配置后下次启动生效",
			currentValue: host.defaultLabel,
			// Submenus bypass the list's change callback, which only fires for rows with
			// `values`; without an explicit refresh the row keeps showing the old label.
			submenu: (_current, done) =>
				animationMenu(
					config,
					target => {
						done(target);
						refresh();
					},
					() => {
						done();
						refresh();
					},
				),
		},
		{
			id: "preview",
			label: "预览",
			description: "立刻播放一次，不改变默认值",
			currentValue: "回车选择视频",
			submenu: (_current, done) =>
				animationMenu(
					config,
					target => {
						done();
						host.preview(target);
					},
					() => done(),
				),
		},
		{
			id: "fit",
			label: "裁剪方式",
			description: "保持宽高比＝完整画面顶部对齐；居中＝完整画面上下均分；方向裁剪＝放大铺满并裁掉超出",
			currentValue: labelOf(FIT_CHOICES, config.fit),
			values: FIT_CHOICES.map(choice => choice.label),
			changed: config.fit !== "contain",
		},
		{
			id: "protocol",
			label: "渲染协议",
			description: "自动＝按终端能力选像素协议，不支持时回退彩色块",
			currentValue: labelOf(PROTOCOL_CHOICES, config.protocol),
			values: PROTOCOL_CHOICES.map(choice => choice.label),
			changed: config.protocol !== "auto",
		},
		{
			id: "fps",
			label: "帧率上限",
			description: "实际帧率取「上限」与「源帧率」的较小值；跟随源＝不设上限",
			currentValue: labelOf(FPS_CHOICES, config.fps),
			values: FPS_CHOICES.map(choice => choice.label),
			changed: config.fps !== 60,
		},
		{
			id: "maxPixels",
			label: "单帧像素上限",
			description: "只改渲染分辨率与内存占用：画面尺寸不变，始终按裁剪方式铺满窗口",
			currentValue: labelOf(MAX_PIXELS_CHOICES, config.maxPixels),
			values: MAX_PIXELS_CHOICES.map(choice => choice.label),
			changed: config.maxPixels !== 0,
		},
		{
			id: "frameBudget",
			label: "帧内存预算",
			description: "整段解码帧的常驻上限，超了自动降帧率而不是缩短时长",
			currentValue: labelOf(BUDGET_CHOICES, Math.round(config.frameBudget / 1_000_000)),
			values: BUDGET_CHOICES.map(choice => choice.label),
			changed: Math.round(config.frameBudget / 1_000_000) !== 512,
		},
		{
			id: "resizeWindow",
			label: "播放时最大化窗口",
			description: "播放前按屏幕像素放大窗口，播完还原",
			currentValue: labelOf(ON_OFF, config.resizeWindow),
			values: ON_OFF.map(choice => choice.label),
			changed: !config.resizeWindow,
		},
		{
			id: "clearCache",
			label: "清理预编码",
			description: "删除已缓存的 SIXEL 序列（换终端/字体/窗口尺寸后旧文件也不再匹配，可一并清掉）",
			currentValue: host.cacheLabel,
			submenu: (_current, done) =>
				choiceMenu(
					[
						{ label: "确认清理", value: "yes" },
						{ label: "取消", value: "no" },
					],
					undefined,
					picked => {
						done();
						if (picked === "yes") host.clearCache();
						// The row shows the size on disk, so it has to be rebuilt after the delete.
						refresh();
					},
					() => {
						done();
						refresh();
					},
				),
		},
		{ id: "heading-playback", label: "播放", heading: true, currentValue: "" },
		{
			id: "allowSkip",
			label: "按键可跳过",
			description: "播放中按任意普通键立即结束",
			currentValue: labelOf(ON_OFF, config.allowSkip),
			values: ON_OFF.map(choice => choice.label),
			changed: !config.allowSkip,
		},
		{
			id: "loop",
			label: "循环次数",
			description: "同一段动画重复播放的次数",
			currentValue: labelOf(LOOP_CHOICES, config.loop),
			values: LOOP_CHOICES.map(choice => choice.label),
			changed: config.loop !== 1,
		},
		{
			id: "takeover",
			label: "接管内置动画",
			description: "首次启动时关闭 omp 自带的启动动画",
			currentValue: labelOf(ON_OFF, config.takeover),
			values: ON_OFF.map(choice => choice.label),
			changed: !config.takeover,
		},
	];
}

/**
 * Pads the panel to the full terminal height. An overlay is sized by the number
 * of rows its component returns, so without this the list would cover only the
 * top half of the screen — nothing like omp's own fullscreen settings screen.
 */
class FullscreenFrame implements Component {
	readonly #inner: Component;

	constructor(inner: Component) {
		this.#inner = inner;
	}

	render(width: number): readonly string[] {
		const lines = [...this.#inner.render(width)];
		const height = Math.max(1, process.stdout.rows ?? 24);
		while (lines.length < height) lines.push("");
		return lines;
	}

	handleInput(data: string): void {
		this.#inner.handleInput?.(data);
	}

	dispose(): void {
		this.#inner.dispose?.();
	}
}

/**
 * Build the panel. `reload` is called after every change so the rows show the
 * values that were actually persisted; `close` runs on Esc.
 */
export function createSettingsPanel(
	host: SettingsHost,
	close: () => void,
	reload: () => SettingsHost,
): Component {
	let list: SettingsList | undefined;
	/** Rebuild every row from the persisted state: values, submenu picks, cache size. */
	const refresh = (): void => {
		list?.setItems(buildItems(reload(), refresh));
	};
	list = new SettingsList(
		buildItems(host, refresh),
		16,
		getSettingsListTheme(),
		(id, value) => {
			applyChange(host, id, value);
			refresh();
		},
		close,
	);
	return new FullscreenFrame(list);
}
