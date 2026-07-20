import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "fs";
import path from "path";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
const OUTPUT_DIR = process.env.OUTPUT_DIR || "wiki-sync-output";

if (!NOTION_TOKEN || !DATA_SOURCE_ID) {
    console.error("NOTION_TOKEN, NOTION_DATA_SOURCE_ID 환경변수가 필요합니다.");
    process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

async function fetchWithRetry(fn, name, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                const delayMs = 5000 * attempt;
                console.warn(`⚠️  시도 ${attempt}/${maxRetries} 실패: ${error.message}`);
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    }
    throw new Error(`${name} 실패 (${maxRetries}회 재시도 후): ${lastError.message}`);
}

function slugify(title) {
    return title.trim().replace(/[\\/:*?"<>|#%]/g, "").replace(/\s+/g, "-") || "untitled";
}

function getTitle(page) {
    const props = page.properties;
    for (const key of Object.keys(props)) {
        if (props[key].type === "title") {
            return props[key].title.map((t) => t.plain_text).join("") || "제목없음";
        }
    }
    return "제목없음";
}

function getSelectValue(page, propName) {
    const prop = page.properties?.[propName];
    return prop?.type === "select" && prop.select ? prop.select.name : "";
}

function getDateValue(page, propName) {
    const prop = page.properties?.[propName];
    return prop?.type === "date" && prop.date ? prop.date.start : "";
}

async function fetchAllPages(dataSourceId) {
    const results = [];
    let cursor = undefined;
    let pageCount = 0;

    do {
        pageCount++;
        console.log(`  - Notion 페이지 조회 중 (배치 ${pageCount})...`);
        const res = await fetchWithRetry(
            async () => await notion.dataSources.query({ data_source_id: dataSourceId, start_cursor: cursor }),
            `Notion 데이터소스 조회 (배치 ${pageCount})`
        );
        results.push(...res.results);
        cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    return results;
}

async function convertPageToMarkdown(page) {
    return await fetchWithRetry(
        async () => {
            const mdBlocks = await n2m.pageToMarkdown(page.id);
            return n2m.toMarkdownString(mdBlocks).parent || "";
        },
        `Markdown 변환 (${getTitle(page)})`
    );
}

async function main() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log("🔍 Notion 데이터소스에서 문서 조회 중...");
    const pages = await fetchAllPages(DATA_SOURCE_ID);
    console.log(`✅ ${pages.length}개 문서를 찾았습니다.`);

    const sidebarLines = ["## 자동 동기화 문서 (Meetings)", ""];
    const now = new Date().toISOString();

    for (const page of pages) {
        const title = getTitle(page);
        const slug = slugify(title);
        const meetingType = getSelectValue(page, "Meeting type");
        const date = getDateValue(page, "Date");

        console.log(`  📝 변환 중: "${title}" -> ${slug}.md`);
        const mdString = await convertPageToMarkdown(page);
        const metaLine = [meetingType, date].filter(Boolean).join(" · ");
        const header =
            `> 이 문서는 Notion(Meetings)에서 자동 동기화되었습니다.\n` +
            `> 마지막 동기화: ${now}\n\n` +
            `# ${title}\n\n` +
            (metaLine ? `**${metaLine}**\n\n` : "");

        const filePath = path.join(OUTPUT_DIR, `${slug}.md`);
        fs.writeFileSync(filePath, header + mdString);
        sidebarLines.push(`- [${title}](${slug})`);
        console.log(`     ✅ 완료: ${slug}.md`);
    }

    const sidebarPath = path.join(OUTPUT_DIR, "_Sidebar.md");
    fs.writeFileSync(sidebarPath, sidebarLines.join("\n") + "\n");
    console.log(`✅ 모든 문서 동기화 완료.`);
}

main().catch((err) => {
    console.error("❌ 동기화 중 오류 발생:", err.message);
    process.exit(1);
});