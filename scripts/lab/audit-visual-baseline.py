#!/usr/bin/env python3
import csv
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageStat


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = ROOT / "research" / "visual-audits"
SOURCES = {
    "walkthrough": ROOT / "research" / "computer-use-runs" / "2026-07-10T22-36-41-198Z" / "shots",
    "network": ROOT / "research" / "pet-walkthrough-harness" / "2026-07-11T00-07-21-914Z-3943a614" / "network-states",
    "scaling": ROOT / "research" / "pet-walkthrough-harness" / "2026-07-11T00-07-21-914Z-3943a614" / "scaling",
}
EXPECTED_COUNTS = {"walkthrough": 27, "network": 4, "scaling": 8}


def utc_slug():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def alpha_bbox(image):
    if "A" not in image.getbands():
        return (0, 0, image.width, image.height)
    alpha = image.getchannel("A")
    return alpha.point(lambda value: 255 if value >= 8 else 0).getbbox()


def pixel_values(image):
    if hasattr(image, "get_flattened_data"):
        return image.get_flattened_data()
    return image.getdata()


def foreground_mask(image):
    alpha = image.getchannel("A")
    if alpha.getextrema()[0] < 255:
        return alpha.point(lambda value: 255 if value >= 8 else 0), "alpha"
    rgb = image.convert("RGB")
    sample_size = max(2, min(12, round(min(image.size) * 0.02)))
    boxes = [
        (0, 0, sample_size, sample_size),
        (image.width - sample_size, 0, image.width, sample_size),
        (0, image.height - sample_size, sample_size, image.height),
        (image.width - sample_size, image.height - sample_size, image.width, image.height),
    ]
    samples = []
    for box in boxes:
        samples.extend(pixel_values(rgb.crop(box)))
    background = tuple(sorted(pixel[channel] for pixel in samples)[len(samples) // 2] for channel in range(3))
    mask = Image.new("L", image.size)
    mask.putdata([
        255 if max(abs(pixel[channel] - background[channel]) for channel in range(3)) >= 18 else 0
        for pixel in pixel_values(rgb)
    ])
    return mask, "corner-background"


def region_ratio(mask, box):
    crop = mask.crop(box)
    pixels = crop.width * crop.height
    if pixels == 0:
        return 0.0
    return sum(1 for value in pixel_values(crop) if value >= 8) / pixels


def inspect_image(path, category):
    with Image.open(path) as source:
        image = source.convert("RGBA")
        width, height = image.size
        mask, mask_source = foreground_mask(image)
        bbox = mask.getbbox()
        visible_pixels = sum(1 for value in pixel_values(mask) if value >= 8)
        visible_ratio = visible_pixels / (width * height)
        luminance = image.convert("RGB").convert("L")
        luminance_stddev = float(ImageStat.Stat(luminance).stddev[0])
        corner_width = max(1, round(width * 0.08))
        corner_height = max(1, round(height * 0.08))
        corner_boxes = [
            (0, 0, corner_width, corner_height),
            (width - corner_width, 0, width, corner_height),
            (0, height - corner_height, corner_width, height),
            (width - corner_width, height - corner_height, width, height),
        ]
        corner_ratios = [region_ratio(mask, box) for box in corner_boxes]
        if bbox:
            center_offset = abs(((bbox[0] + bbox[2]) / 2) - (width / 2)) / width
            bbox_width_ratio = (bbox[2] - bbox[0]) / width
            bbox_height_ratio = (bbox[3] - bbox[1]) / height
        else:
            center_offset = 1.0
            bbox_width_ratio = 0.0
            bbox_height_ratio = 0.0
        checks = {
            "validDimensions": 300 <= width <= 1000 and 450 <= height <= 1200,
            "notBlank": visible_ratio >= 0.10 and luminance_stddev >= 8.0,
            "contentCentered": center_offset <= 0.08,
            "contentSubstantial": bbox_width_ratio >= 0.55 and bbox_height_ratio >= 0.70,
            "cornersNotClipped": mask_source != "alpha" or max(corner_ratios) <= 0.45,
        }
        return {
            "category": category,
            "path": str(path.relative_to(ROOT)).replace(os.sep, "/"),
            "filename": path.name,
            "sha256": file_hash(path),
            "bytes": path.stat().st_size,
            "width": width,
            "height": height,
            "visibleRatio": round(visible_ratio, 6),
            "luminanceStddev": round(luminance_stddev, 3),
            "alphaBounds": list(bbox) if bbox else None,
            "maskSource": mask_source,
            "cornerCheckApplicable": mask_source == "alpha",
            "centerOffsetRatio": round(center_offset, 6),
            "boundsWidthRatio": round(bbox_width_ratio, 6),
            "boundsHeightRatio": round(bbox_height_ratio, 6),
            "cornerVisibleRatios": [round(value, 6) for value in corner_ratios],
            "checks": checks,
            "passed": all(checks.values()),
        }


def contact_sheet(items, output_path, title):
    columns = 4
    cell_width = 250
    image_height = 360
    label_height = 56
    header_height = 42
    rows = math.ceil(len(items) / columns)
    sheet = Image.new("RGB", (columns * cell_width, header_height + rows * (image_height + label_height)), "#202522")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    draw.text((12, 12), title, fill="#f4f2df", font=font)
    for index, item in enumerate(items):
        row, column = divmod(index, columns)
        x = column * cell_width
        y = header_height + row * (image_height + label_height)
        with Image.open(ROOT / item["path"]) as source:
            preview = source.convert("RGBA")
            preview.thumbnail((cell_width - 18, image_height - 16), Image.Resampling.LANCZOS)
            background = Image.new("RGBA", preview.size, "#111513")
            background.alpha_composite(preview)
            px = x + (cell_width - preview.width) // 2
            py = y + (image_height - preview.height) // 2
            sheet.paste(background.convert("RGB"), (px, py))
        status = "PASS" if item["passed"] else "FAIL"
        draw.text((x + 8, y + image_height + 7), f"{status}  {item['filename'][:34]}", fill="#b8d8a9" if item["passed"] else "#ff9d8d", font=font)
        draw.text((x + 8, y + image_height + 25), f"{item['width']}x{item['height']}  center {item['centerOffsetRatio']:.3f}", fill="#d7d4bf", font=font)
    sheet.save(output_path, "PNG", optimize=True)


def main():
    run_id = utc_slug() + "-stable-baseline"
    output_dir = OUTPUT_ROOT / run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    records = []
    category_counts = {}
    for category, directory in SOURCES.items():
        paths = sorted(directory.glob("*.png"))
        category_counts[category] = len(paths)
        records.extend(inspect_image(path, category) for path in paths)
    hashes = {}
    for record in records:
        hashes.setdefault(record["sha256"], []).append(record["path"])
    duplicates = [paths for paths in hashes.values() if len(paths) > 1]
    count_checks = {category: category_counts.get(category, 0) == expected for category, expected in EXPECTED_COUNTS.items()}
    all_image_checks = all(record["passed"] for record in records)
    unique_checks = not duplicates
    passed = all(count_checks.values()) and all_image_checks and unique_checks
    manifest = {
        "version": 1,
        "runId": run_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceRuns": [
            "research/computer-use-runs/2026-07-10T22-36-41-198Z",
            "research/pet-walkthrough-harness/2026-07-11T00-07-21-914Z-3943a614",
        ],
        "bounds": {
            "width": [300, 1000],
            "height": [450, 1200],
            "minimumVisibleRatio": 0.10,
            "minimumLuminanceStddev": 8.0,
            "maximumHorizontalCenterOffsetRatio": 0.08,
            "minimumAlphaBoundsWidthRatio": 0.55,
            "minimumAlphaBoundsHeightRatio": 0.70,
            "maximumCornerVisibleRatio": 0.45,
            "exactDuplicateImagesAllowed": False,
        },
        "expectedCounts": EXPECTED_COUNTS,
        "secretsRecorded": False,
    }
    summary = {
        "version": 1,
        "runId": run_id,
        "passed": passed,
        "categoryCounts": category_counts,
        "countChecks": count_checks,
        "allImageChecks": all_image_checks,
        "uniqueChecks": unique_checks,
        "duplicates": duplicates,
        "failedImages": [record["path"] for record in records if not record["passed"]],
        "images": records,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    with (output_dir / "metrics.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["category", "path", "sha256", "bytes", "width", "height", "visible_ratio", "luminance_stddev", "center_offset_ratio", "bounds_width_ratio", "bounds_height_ratio", "max_corner_ratio", "passed"])
        for record in records:
            writer.writerow([
                record["category"], record["path"], record["sha256"], record["bytes"], record["width"], record["height"],
                record["visibleRatio"], record["luminanceStddev"], record["centerOffsetRatio"], record["boundsWidthRatio"],
                record["boundsHeightRatio"], max(record["cornerVisibleRatios"]), record["passed"],
            ])
    for category in SOURCES:
        items = [record for record in records if record["category"] == category]
        contact_sheet(items, output_dir / f"{category}-contact-sheet.png", f"Versus stable states: {category}")
    report = [
        "# Stable-State Visual Bounds Audit",
        "",
        f"- Run: `{run_id}`",
        f"- Result: **{'PASS' if passed else 'FAIL'}**",
        f"- Screenshots: {len(records)}",
        f"- Counts: {category_counts}",
        f"- Failed images: {len(summary['failedImages'])}",
        f"- Exact duplicates: {len(duplicates)}",
        "",
        "This machine audit proves that the required stable captures exist, are nonblank, have substantial centered content, transparent captures remain inside the approved corner bounds, and no captures are accidental duplicates. Opaque Windows captures retain their desktop background and are reviewed through the generated contact sheets. This does not replace the owner's aesthetic acceptance.",
        "",
    ]
    (output_dir / "REPORT.md").write_text("\n".join(report), encoding="utf-8")
    print(("PASS " if passed else "FAIL ") + str(output_dir))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
