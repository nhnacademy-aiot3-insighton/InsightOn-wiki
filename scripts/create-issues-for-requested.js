// Notion Meetings DB에서 "Wiki 동기화" 체크박스(버튼으로 켜짐)가 켜진 페이지를 찾아
// 해당 페이지 내용 그대로 GitHub 이슈로 등록하고, 처리 후 체크박스를 다시 끄는 스크립트.
//
// 트리거 흐름: Notion "Wiki 동기화" 버튼 클릭 -> 체크박스 켜짐
//   -> (이 스크립트가 주기적으로 폴링) 체크박스 켜진 페이지 발견
//   -> GitHub 이슈 생성(본문 = 회의 내용 그대로) + "GitHub Issue URL" 프로퍼티에 이슈 링크 기록
//   -> 체크박스 다시 끔 (중복 처리 방지)
//   -> 같은 워크플로우의 다음 단계(sync-notion-to-wiki.js)가 Wiki에도 반영
//
// 이슈 생성 후에는 팀 칸반보드(PROJECT_URL, 아래 하드코딩)에도 자동으로 등록합니다.
// Notion 쪽 "GitHub Project URL" 프로퍼티는 이 자동화에서는 사용하지 않습니다
// (회의별로 다른 보드를 쓰지 않고 항상 같은 팀 프로젝트 보드에 모으기로 결정함).
//
// 필요한 환경변수:
//   NOTION_TOKEN            Notion 내부 통합 토큰
//   NOTION_DATA_SOURCE_ID   Meetings 데이터소스 ID
//   GITHUB_ISSUE_TOKEN      이슈/프로젝트 등록용 GitHub 토큰 (classic PAT).
//                           repo 스코프 + project 스코프 둘 다 필요합니다 - WIKI_SYNC_PAT 재사용.
//                           (기존 WIKI_SYNC_PAT을 만들 때 project 스코프를 안 넣었다면,
//                            토큰을 새로 만들 필요 없이 GitHub 설정에서 그 토큰을 열어
//                            project 스코프만 추가 체크하고 저장하면 됩니다.)
//   DEFAULT_ISSUE_REPO      (선택) Repository 프로퍼티가 비어있을 때 이슈를 등록할 기본 레포 ("owner/repo").
//                           비워두면 이 워크플로우가 실행 중인 레포(GITHUB_REPOSITORY)를 기본값으로 씁니다.

import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";

// 팀 칸반보드 (하드코딩) — 바꾸고 싶으면 이 값만 수정하세요.
const PROJECT_URL = "https://github.com/orgs/nhnacademy-aiot3-insighton/projects/1";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
const GITHUB_ISSUE_TOKEN = process.env.GITHUB_ISSUE_TOKEN;
const DEFAULT_ISSUE_REPO =
    process.env.DEFAULT_ISSUE_REPO || process.env.GITHUB_REPOSITORY || "";

const SYNC_PROPERTY = "Wiki 동기화";

if (!NOTION_TOKEN || !DATA_SOURCE_ID || !GITHUB_ISSUE_TOKEN) {
    console.error(
        "NOTION_TOKEN, NOTION_DATA_SOURCE_ID, GITHUB_ISSUE_TOKEN 환경변수가 필요합니다."
    );
    process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

function getTitle(page) {
    const props = page.properties;
    for (const key of Object.keys(props)) {
        if (props[key].type === "title") {
            const text = props[key].title.map((t) => t.plain_text).join("");
            return text || "제목없음";
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

// Meeting type -> GitHub 라벨 매핑 ("Scrum"은 회의록 자동 생성 스크립트가 찾는 공통 라벨)
const MEETING_TYPE_LABELS = {
    DailyScrum: ["Scrum", "DailyScrum"],
    WeeklyMeeting: ["Scrum", "WeeklyMeeting"],
    TeamMeeting: ["Scrum", "TeamMeeting"],
    EmergencyMeeting: ["Scrum", "EmergencyMeeting"],
};

// Repository 프로퍼티(예: https://github.com/owner/repo)에서 "owner/repo" 파싱
function parseOwnerRepo(repoUrl) {
    if (!repoUrl) return null;
    const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : null;
}

async function findRequestedPages() {
    const results = [];
    let cursor = undefined;
    do {
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
    return results;
}

async function ensureLabelsExist(ownerRepo, labels) {
    // 라벨이 레포에 없으면 이슈 생성 시 GitHub가 자동으로 만들어주지 않으므로 미리 생성해둠.
    for (const name of labels) {
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

// GitHub Projects v2는 REST가 아니라 GraphQL API만 지원합니다.
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
        throw new Error(
            `GitHub GraphQL 오류: ${res.status} ${JSON.stringify(json.errors || json)}`
        );
    }
    return json.data;
}

// 프로젝트 URL 형식: https://github.com/orgs/<org>/projects/<number>
//                또는 https://github.com/users/<user>/projects/<number>
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
    const proj =
        ownerType === "orgs" ? data.organization?.projectV2 : data.user?.projectV2;
    if (!proj) {
        throw new Error(`프로젝트를 찾을 수 없습니다 (${ownerType}/${login}/${number})`);
    }
    return proj.id;
}

async function addIssueToProject(projectNodeId, issueNodeId) {
    const mutation = `mutation($projectId:ID!,$contentId:ID!){ addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}){ item { id } } }`;
    await githubGraphql(mutation, { projectId: projectNodeId, contentId: issueNodeId });
}

async function main() {
    const pages = await findRequestedPages();
    console.log(`Wiki 동기화 요청된 문서 ${pages.length}건 발견.`);

    for (const page of pages) {
        const title = getTitle(page);
        const repoUrl = getUrlValue(page, "Repository");
        const ownerRepo = parseOwnerRepo(repoUrl) || DEFAULT_ISSUE_REPO;

        if (!ownerRepo) {
            console.warn(
                `  - "${title}": Repository 프로퍼티도 비어있고 기본 레포도 없어서 건너뜁니다.`
            );
            continue;
        }

        const meetingType = getSelectValue(page, "Meeting type");
        const date = getDateValue(page, "Date");
        const scrumMaster = getPersonName(page, "ScrumMaster");
        const labels = MEETING_TYPE_LABELS[meetingType] || ["Scrum"];

        const mdBlocks = await n2m.pageToMarkdown(page.id);
        const mdString = n2m.toMarkdownString(mdBlocks).parent || "";
        const metaLines = [
            `> Notion에서 자동 등록된 이슈입니다. 원본: ${page.url}`,
            `- **날짜**: ${date || "-"}`,
            `- **스크럼마스터**: ${scrumMaster || "-"}`,
        ].join("\n");
        const body = `${metaLines}\n\n${mdString}`;

        try {
            const issue = await createGithubIssue(ownerRepo, title, body, labels);
            console.log(`  - "${title}" -> ${ownerRepo}#${issue.number} 이슈 생성 완료`);

            const parsedProject = parseProjectUrl(PROJECT_URL);
            if (parsedProject) {
                try {
                    const projectNodeId = await getProjectNodeId(parsedProject);
                    await addIssueToProject(projectNodeId, issue.node_id);
                    console.log(`    -> 칸반보드(${PROJECT_URL})에도 등록 완료`);
                } catch (projErr) {
                    console.error(`    -> 칸반보드 등록 실패: ${projErr.message}`);
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
            // 실패한 건은 체크박스를 끄지 않고 남겨둬서 다음 폴링에서 재시도되게 함
            console.error(`  - "${title}" 처리 실패:`, err.message);
        }
    }

    console.log("이슈 등록 처리 완료.");
}

main().catch((err) => {
    console.error("이슈 등록 중 오류 발생:", err);
    process.exit(1);
});