package services

import (
	"regexp"
	"strings"
	"testing"
)

// Phase 0 of the Isolated Conflict Resolution Plan locked down the wording for
// every outcome the isolated integration workflow can report. Phase 2 moved the
// map itself into integration_session_service.go; these tests stayed behind and
// now enforce the two rules against the production strings.

var integrationSessionOutcomeStates = []string{
	"scheduled", "fetching", "starting", "needs-decisions", "committing", "updated",
	"sharing", "shared", "blocked", "cancelling", "cancelled", "failed",
}

// gitJargonPattern matches the vocabulary users of IOFabrik do not know.
// Word boundaries matter: "refreshed" must not trip the "ref" rule.
var gitJargonPattern = regexp.MustCompile(`(?i)\b(commit|commits|committed|branch|branches|merge|merged|merging|rebase|stash|head|sha|staging|staged|index|checkout|push|pushed|pull|repo|repository|worktree|ref|refs|upstream|origin|remote|revision|oid|detached)\b`)

func TestIntegrationSessionOutcomeMessagesCoverEveryState(t *testing.T) {
	if len(integrationSessionOutcomeMessages) != len(integrationSessionOutcomeStates) {
		t.Fatalf("expected %d messages, got %d", len(integrationSessionOutcomeStates), len(integrationSessionOutcomeMessages))
	}
	for _, state := range integrationSessionOutcomeStates {
		if strings.TrimSpace(integrationSessionOutcomeMessages[state]) == "" {
			t.Fatalf("no message for state %q", state)
		}
	}
}

func TestIntegrationSessionOutcomeMessagesAvoidGitJargon(t *testing.T) {
	for state, message := range integrationSessionOutcomeMessages {
		if found := gitJargonPattern.FindString(message); found != "" {
			t.Errorf("state %q exposes git jargon %q: %s", state, found, message)
		}
	}
}

func TestIntegrationSessionOutcomeMessagesStateWhatHappenedThenNextStep(t *testing.T) {
	for state, message := range integrationSessionOutcomeMessages {
		sentences := 0
		for _, part := range strings.Split(message, ".") {
			if strings.TrimSpace(part) != "" {
				sentences++
			}
		}
		if sentences < 2 {
			t.Errorf("state %q needs what happened plus a next step: %s", state, message)
		}
		if !strings.HasSuffix(message, ".") {
			t.Errorf("state %q message is not a complete sentence: %s", state, message)
		}
	}
}
