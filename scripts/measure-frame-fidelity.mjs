#!/usr/bin/env node
/**
 * Frame-fidelity audit for `assets/whale-pet/`.
 *
 * The strip ships 72 px indexed PNGs resampled from a 96 px canvas. That is the
 * only lossy step in the asset pipeline, and the docs quote a measured error for
 * it, so this script recomputes that error instead of trusting the prose.
 *
 * It compares each shipped frame against its 96 px source, area-averaged to
 * 72 px, in premultiplied RGBA (the space a terminal actually blends in) and
 * prints per-frame and aggregate RMSE plus PSNR. The 96 px sources are not at
 * HEAD; by default they are read from commit `dd048d1` via `git show`. Pass a
 * directory of 96 px frames as the first positional argument, or a different ref
 * with `--ref`, to audit against another source.
 *
 *   node scripts/measure-frame-fidelity.mjs
 *   node scripts/measure-frame-fidelity.mjs --ref <sha>
 *   node scripts/measure-frame-fidelity.mjs /path/to/96px/frames
 *
 * Report-only: it never fails a build, because a different ImageMagick build
 * yields an equivalent-but-not-bit-identical palette.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED_DIR = join(ROOT, "assets", "whale-pet");

const argv = process.argv.slice(2);
function flag(name, fallback) {
	const at = argv.indexOf(name);
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
}
const ref = flag("--ref", "dd048d1");
const positional = argv.find((a) => !a.startsWith("--") && a !== ref);
const sourceDir = positional !== undefined && existsSync(positional) ? positional : null;

/** Decode an 8-bit, non-interlaced PNG (truecolour+alpha or indexed+`tRNS`) to RGBA. */
function decodePng(png) {
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	const colorType = png.readUInt8(25);
	if (png.readUInt8(24) !== 8) throw new Error("expected 8-bit channels");
	if (colorType !== 6 && colorType !== 3) throw new Error(`unsupported colour type ${colorType}`);
	if (png.readUInt8(28) !== 0) throw new Error("interlaced PNGs are not supported");
	const bytesPerPixel = colorType === 6 ? 4 : 1;

	const parts = [];
	let palette = null;
	let transparency = null;
	for (let offset = 8; offset < png.length; ) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		const body = png.subarray(offset + 8, offset + 8 + length);
		if (type === "IDAT") parts.push(body);
		else if (type === "PLTE") palette = body;
		else if (type === "tRNS") transparency = body;
		if (type === "IEND") break;
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(parts));
	const stride = width * bytesPerPixel;
	const previous = Buffer.alloc(stride);
	const current = Buffer.alloc(stride);
	const rgba = Buffer.alloc(width * height * 4);
	let cursor = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[cursor];
		cursor += 1;
		for (let i = 0; i < stride; i++) {
			const value = raw[cursor + i];
			const left = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
			const up = previous[i];
			const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
			let restored;
			if (filter === 0) restored = value;
			else if (filter === 1) restored = (value + left) & 0xff;
			else if (filter === 2) restored = (value + up) & 0xff;
			else if (filter === 3) restored = (value + ((left + up) >> 1)) & 0xff;
			else {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
				restored = (value + predictor) & 0xff;
			}
			current[i] = restored;
		}
		for (let x = 0; x < width; x++) {
			const out = (y * width + x) * 4;
			if (colorType === 6) {
				rgba[out] = current[x * 4];
				rgba[out + 1] = current[x * 4 + 1];
				rgba[out + 2] = current[x * 4 + 2];
				rgba[out + 3] = current[x * 4 + 3];
			} else {
				const index = current[x];
				rgba[out] = palette[index * 3];
				rgba[out + 1] = palette[index * 3 + 1];
				rgba[out + 2] = palette[index * 3 + 2];
				rgba[out + 3] =
					transparency === null || index >= transparency.length ? 0xff : transparency[index];
			}
		}
		current.copy(previous);
		cursor += stride;
	}
	return { width, height, rgba };
}

/** Area-average an RGBA buffer down to `dw×dh`, keeping the result premultiplied. */
function areaDownscale(src, sw, sh, dw, dh) {
	const out = Buffer.alloc(dw * dh * 4);
	const scaleX = sw / dw;
	const scaleY = sh / dh;
	for (let y = 0; y < dh; y++) {
		for (let x = 0; x < dw; x++) {
			const x0 = Math.floor(x * scaleX);
			const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
			const y0 = Math.floor(y * scaleY);
			const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const si = (sy * sw + sx) * 4;
					const alpha = src[si + 3] / 255;
					r += src[si] * alpha;
					g += src[si + 1] * alpha;
					b += src[si + 2] * alpha;
					a += src[si + 3];
					n++;
				}
			}
			const di = (y * dw + x) * 4;
			const alpha = a / n;
			const unpremultiply = alpha === 0 ? 0 : 255 / alpha;
			out[di] = Math.round((r / n) * unpremultiply);
			out[di + 1] = Math.round((g / n) * unpremultiply);
			out[di + 2] = Math.round((b / n) * unpremultiply);
			out[di + 3] = Math.round(alpha);
		}
	}
	return out;
}

/** Premultiplied-RGBA RMSE (percent) and PSNR (dB) between two RGBA buffers. */
function premultipliedError(a, b) {
	let squared = 0;
	for (let i = 0; i < a.length; i += 4) {
		const alphaA = a[i + 3];
		const alphaB = b[i + 3];
		for (let c = 0; c < 4; c++) {
			const va = c === 3 ? alphaA : (a[i + c] * alphaA) / 255;
			const vb = c === 3 ? alphaB : (b[i + c] * alphaB) / 255;
			const delta = (va - vb) / 255;
			squared += delta * delta;
		}
	}
	const mse = squared / a.length;
	return { rmse: Math.sqrt(mse) * 100, psnr: mse === 0 ? Infinity : 10 * Math.log10(1 / mse) };
}

function loadSource(name) {
	if (sourceDir !== null) {
		const path = join(sourceDir, name);
		return existsSync(path) ? readFileSync(path) : null;
	}
	try {
		return execFileSync("git", ["show", `${ref}:assets/whale-pet/${name}`], {
			cwd: ROOT,
			maxBuffer: 1 << 26,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

const frames = readdirSync(SHIPPED_DIR)
	.filter((name) => name.endsWith(".png"))
	.sort();
if (frames.length === 0) {
	console.error(`no frames found in ${SHIPPED_DIR}`);
	process.exit(1);
}

const origin = sourceDir ?? `git ${ref}:assets/whale-pet/`;
console.log(`comparing ${frames.length} shipped frames against ${origin} (96 px, area-averaged to 72 px)\n`);

let total = 0;
let worst = { name: "", rmse: 0 };
let checked = 0;
for (const name of frames) {
	const source = loadSource(name);
	if (source === null) {
		console.log(`  ${name.padEnd(16)} source unavailable — skipped`);
		continue;
	}
	const shipped = decodePng(readFileSync(join(SHIPPED_DIR, name)));
	const sourceImage = decodePng(source);
	const reference = areaDownscale(
		sourceImage.rgba,
		sourceImage.width,
		sourceImage.height,
		shipped.width,
		shipped.height,
	);
	const { rmse, psnr } = premultipliedError(shipped.rgba, reference);
	total += rmse;
	checked++;
	if (rmse > worst.rmse) worst = { name, rmse };
	console.log(`  ${name.padEnd(16)} RMSE ${rmse.toFixed(2)} %   PSNR ${psnr.toFixed(2)} dB`);
}

if (checked === 0) {
	console.error(`\nno sources could be read; pass a directory of 96 px frames or a valid --ref`);
	process.exit(1);
}
console.log(
	`\naverage RMSE ${(total / checked).toFixed(2)} %   worst ${worst.name} ${worst.rmse.toFixed(2)} %`,
);
