/** GraphQL documents. Kept as plain strings so `gh api graphql` can POST them. */

/**
 * `isRequired` takes a pullRequestNumber argument, which a search result can't
 * supply (each node is a different PR) — so the list query uses the basic
 * rollup and only the per-PR queries ask whether a check is required.
 */
const rollup = (requiredArg: string) => `
  statusCheckRollup {
    state
    contexts(first: 100) {
      nodes {
        __typename
        ... on CheckRun {
          name
          conclusion
          status
          detailsUrl
          ${requiredArg}
        }
        ... on StatusContext {
          context
          state
          targetUrl
          ${requiredArg}
        }
      }
    }
  }
`;

const CHECK_ROLLUP = rollup("");
const CHECK_ROLLUP_WITH_REQUIRED = rollup("isRequired(pullRequestNumber: $number)");

/**
 * Search is the heaviest query we run: GitHub times out (502) when a broad
 * result set is multiplied by large nested connections. So the file list is
 * only requested when a path filter actually needs it, and the check contexts
 * are capped well below the connection limit.
 */
export function searchPrsQuery(includeFiles: boolean): string {
  return `
query SearchPrs($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest {
        number
        title
        url
        createdAt
        updatedAt
        isDraft
        additions
        deletions
        changedFiles
        baseRefName
        headRefName
        mergeable
        reviewDecision
        author { login avatarUrl }
        repository { name owner { login } defaultBranchRef { name } }
        labels(first: 10) { nodes { name color } }
        assignees(first: 5) { nodes { login } }
        reviewRequests(first: 10) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug }
            }
          }
        }
        latestReviews(first: 10) { nodes { state author { login } commit { oid } } }
        ${includeFiles ? "files(first: 100) { nodes { path } pageInfo { hasNextPage } }" : ""}
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                state
                contexts(first: 40) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion status detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;
}

export const PR_DETAIL = `
query PrDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      number
      title
      url
      body
      bodyHTML
      state
      createdAt
      updatedAt
      isDraft
      additions
      deletions
      changedFiles
      baseRefName
      headRefName
      mergeable
      reviewDecision
      author { login avatarUrl }
      repository { name owner { login } }
      labels(first: 30) { nodes { name color } }
      assignees(first: 10) { nodes { login } }
      reviewRequests(first: 25) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login }
            ... on Team { slug }
          }
        }
      }
      latestReviews(first: 25) { nodes { state author { login } commit { oid } } }
      files(first: 100) {
        nodes { path additions deletions changeType }
        pageInfo { hasNextPage }
      }
      commits(first: 100) {
        nodes {
          commit {
            oid
            messageHeadline
            messageBody
            committedDate
            url
            author { name user { login } }
          }
        }
      }
      comments(last: 50) {
        nodes { id body bodyHTML createdAt url author { login avatarUrl } }
      }
      reviews(last: 30) {
        nodes { id body bodyHTML state submittedAt url author { login avatarUrl } commit { oid } }
      }
      reviewThreads(first: 60) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes { id body bodyHTML createdAt url diffHunk path line author { login avatarUrl } }
          }
        }
      }
    }
  }
}`;

export const PR_HEAD = `
query PrHead($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) { nodes { commit { oid ${CHECK_ROLLUP_WITH_REQUIRED} } } }
    }
  }
}`;

/** The head commit's checks, fetched separately so the big detail query stays cheap. */
export const PR_CHECKS = `
query PrChecks($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { oid ${CHECK_ROLLUP_WITH_REQUIRED} } } }
    }
  }
}`;

/** Lightweight view of the PRs I opened, for "someone reviewed your PR". */
export const MY_PRS = `
query MyPrs($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      __typename
      ... on PullRequest {
        number
        title
        url
        updatedAt
        reviewDecision
        repository { name owner { login } }
        latestReviews(first: 20) {
          nodes { state submittedAt author { login } }
        }
        commits(last: 1) {
          nodes { commit { oid statusCheckRollup { state } } }
        }
      }
    }
  }
}`;
