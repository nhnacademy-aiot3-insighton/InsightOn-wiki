import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";

const PROJECT_URL = "https://github.com/orgs/nhnacademy-aiot3-insighton/projects/1";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
const GITHUB_ISSUE_TOKEN = process.env.WIKI_SYNC_PAT || process.env.GITHUB_ISSUE_TOKEN;
const DEFAULT_ISSUE_REPO = process.env.DEFAULT_ISSUE_REPO || process.env.GITHUB_REPOSITORY || "";

const SYNC_PROPERTY = "Wiki 동기화";

if (!NOTION_TOKEN || !DATA_SOURCE_ID || !GITHUB_ISSUE_TOKEN) {
    console.error("NOTION_TOKEN, NOTION_DATA_SOURCE_ID, GITHUB_ISSUE_TOKEN 환경변수가 필요합니다.");
    process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

function getTitle(page) {
    const props = page.properties;
    for (const key of Object.keys(props)) {
        if (props[key].type === "title") {
            return props[key].title.map((t) => t.plain_text).join("") || "제목없음";
        }
    }
    return "제목없음";
}

function getUrlValue(page, propName) {
    const prop = page.properties?.[propName];
    return prop?.type === "url" && prop.url ? prop.url : "";
}

function getSelectValue(page, propName) {
    const prop = page.properties?.[propName];
    return prop?.type === "select" && prop.select ? prop.select.name : "";
}

function getDateValue(page, propName) {
    const prop = page.properties?.[propName];
    return prop?.type === "date" && prop.date ? prop.date.start : "";
}

function getPersonName(page, propName) {
    const prop = page.properties?.[propName];
    if (prop?.type === "people" && prop.people?.length > 0) {
        return prop.people[0].name || "";
    }
    return "";
}

const MEETING_TYPE_LABELS = {
    DailyScrum: ["Scrum", "DailyScrum"],
    WeeklyMeeting: ["Scrum", "WeeklyMeeting"],
    TeamMeeting: ["Scrum", "TeamMeeting"],
    EmergencyMeeting: ["Scrum", "EmergencyMeeting"],
};

function parseOwnerRepo(repoUrl) {
    if (!repoUrl) return null;
    const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : null;
}

async function findRequestedPages() {
    const results = [];
    let cursor = undefined;

    try {
        // Notion SDK v5+ 호환: dataSources.query 사용
        do {
            console.log("  - Notion 페이지 조회 중...");
            const res = await notion.dataSources.query({
                data_source_id: DATA_SOURCE_ID,
                start_cursor: cursor,
                filter: {
                    property: SYNC_PROPERTY,
                    checkbox: { equals: true },
                },
            });
            results.push(...res.results);
            cursor = res.has_more ? res.next_cursor : undefined;
        } while (cursor);
    } catch (err) {
        // 폴백: 기존 방식 시도 (SDK 버전이 다를 경우)
        if (err.message?.includes("dataSources")) {
            console.warn("⚠️  dataSources.query 실패, 대체 방식 시도...");
            console.error("Notion SDK 버전을 확인하세요. v5+ 필요합니다.");
            throw new Error("Notion SDK 버전이 맞지 않습니다. npm install @notionhq/client@latest 실행하세요.");
        }
        throw err;
    }

    return results;
}

async function ensureLabelsExist(ownerRepo, labels) {
    for (const name of labels) {
        try {
            const res = await fetch(
                `https://api.github.com/repos/${ownerRepo}/labels/${encodeURIComponent(name)}`,
                {
                    headers: {
                        Authorization: `Bearer ${GITHUB_ISSUE_TOKEN}`,
                        Accept: "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                }
            );
            if (res.status === 404) {
                await fetch(`https://api.github.com/repos/${ownerRepo}/labels`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${GITHUB_ISSUE_TOKEN}`,
                        Accept: "application/vnd.github+json",
                        "Content-Type": "application/json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                    body: JSON.stringify({ name, color: "6f42c1" }),
                });
            }
        } catch (err) {
            console.warn(`  ⚠️  라벨 "${name}" 생성 실패: ${err.message}`);
        }
    }
}

async function createGithubIssue(ownerRepo, title, body, labels) {
    if (labels?.length) {
        await ensureLabelsExist(ownerRepo, labels);
    }
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}/issues`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${GITHUB_ISSUE_TOKEN}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ title, body, labels: labels || [] }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub 이슈 생성 실패 (${ownerRepo}): ${res.status} ${text}`);
    }
    return res.json();
}

async function githubGraphql(query, variables) {
    const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${GITHUB_ISSUE_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!res.ok || json.errors) {
        throw new Error(`GitHub GraphQL 오류: ${JSON.stringify(json.errors || json)}`);
    }
    return json.data;
}

function parseProjectUrl(url) {
    if (!url) return null;
    const m = url.match(/github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)/);
    if (!m) return null;
    return { ownerType: m[1], login: m[2], number: Number(m[3]) };
}

async function getProjectNodeId({ ownerType, login, number }) {
    const query =
        ownerType === "orgs"
            ? `query($login:String!,$number:Int!){ organization(login:$login){ projectV2(number:$number){ id } } }`
            : `query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id } } }`;
    const data = await githubGraphql(query, { login, number });
    const proj = ownerType === "orgs" ? data.organization?.projectV2 : data.user?.projectV2;
    if (!proj) {
        throw new Error(`프로젝트를 찾을 수 없습니다`);
    }
    return proj.id;
}

async function addIssueToProject(projectNodeId, issueNodeId) {
    const mutation = `mutation($projectId:ID!,$contentId:ID!){ addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}){ item { id } } }`;
    await githubGraphql(mutation, { projectId: projectNodeId, contentId: issueNodeId });
}

async function main() {
    console.log("🔍 Notion에서 Wiki 동기화 요청 찾는 중...");
    const pages = await findRequestedPages();
    console.log(`✅ Wiki 동기화 요청된 문서 ${pages.length}건 발견.`);

    for (const page of pages) {
        const title = getTitle(page);
        const repoUrl = getUrlValue(page, "Repository");
        const ownerRepo = parseOwnerRepo(repoUrl) || DEFAULT_ISSUE_REPO;

        if (!ownerRepo) {
            console.warn(`  ⚠️  "${title}": Repository 프로퍼티가 비어있습니다.`);
            continue;
        }

        const meetingType = getSelectValue(page, "Meeting type");
        const date = getDateValue(page, "Date");
        const scrumMaster = getPersonName(page, "ScrumMaster");
        const labels = MEETING_TYPE_LABELS[meetingType] || ["Scrum"];

        try {
            console.log(`  📝 "${title}" 처리 중...`);
            const mdBlocks = await n2m.pageToMarkdown(page.id);
            const mdString = n2m.toMarkdownString(mdBlocks).parent || "";
            const metaLines = [
                `> Notion에서 자동 등록. 원본: ${page.url}`,
                `- **날짜**: ${date || "-"}`,
                `- **스크럼마스터**: ${scrumMaster || "-"}`,
            ].join("\n");
            const body = `${metaLines}\n\n${mdString}`;

            const issue = await createGithubIssue(ownerRepo, title, body, labels);
            console.log(`     ✅ ${ownerRepo}#${issue.number} 이슈 생성`);

            const parsedProject = parseProjectUrl(PROJECT_URL);
            if (parsedProject) {
                try {
                    const projectNodeId = await getProjectNodeId(parsedProject);
                    await addIssueToProject(projectNodeId, issue.node_id);
                    console.log(`     ✅ 칸반보드에 등록`);
                } catch (projErr) {
                    console.warn(`     ⚠️  칸반보드 등록 실패: ${projErr.message}`);
                }
            }

            await notion.pages.update({
                page_id: page.id,
                properties: {
                    "GitHub Issue URL": { url: issue.html_url },
                    [SYNC_PROPERTY]: { checkbox: false },
                },
            });
        } catch (err) {
            console.error(`  ❌ "${title}" 처리 실패: ${err.message}`);
        }
    }

    console.log("✅ 이슈 등록 처리 완료.");
}

main().catch((err) => {
    console.error("❌ 오류:", err.message);
    process.exit(1);
});