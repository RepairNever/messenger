//go:build integration

package botapi_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/tasks"
)

func TestIntegration_BotAPI_TaskDetailsSubtasks(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Task Details Owner")
	template, err := env.tasks.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "SUB", SortOrder: 1, ActorID: human})
	require.NoError(t, err)
	open, err := env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "bot_details_open", Name: "Open", SortOrder: 1, ActorID: human})
	require.NoError(t, err)
	done, err := env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "bot_details_done", Name: "Done", SortOrder: 2, ActorID: human})
	require.NoError(t, err)
	parent, err := env.tasks.CreateTask(ctx, tasks.CreateTaskParams{TemplateID: template.ID, Title: "Parent task", StatusID: open.ID, ActorID: human})
	require.NoError(t, err)
	newer, err := env.tasks.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: template.ID, ParentTaskID: &parent.ID, Title: "A newer open subtask", StatusID: open.ID, ActorID: human,
	})
	require.NoError(t, err)
	older, err := env.tasks.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: template.ID, ParentTaskID: &parent.ID, Title: "Z older completed subtask", StatusID: done.ID, ActorID: human,
	})
	require.NoError(t, err)
	childless, err := env.tasks.CreateTask(ctx, tasks.CreateTaskParams{TemplateID: template.ID, Title: "Task without subtasks", StatusID: open.ID, ActorID: human})
	require.NoError(t, err)

	// Make creation-time order differ from both public-ID and title order.
	base := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	_, err = env.pool.Exec(ctx, `UPDATE task SET created_at = $2 WHERE id = $1`, older.ID, base)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `UPDATE task SET created_at = $2 WHERE id = $1`, newer.ID, base.Add(time.Hour))
	require.NoError(t, err)

	t.Run("parent includes all subtasks in creation order", func(t *testing.T) {
		status, body := env.do(t, http.MethodGet, "/api/bot/v1/tasks/"+parent.PublicID, env.token, nil)
		require.Equal(t, http.StatusOK, status)
		assert.NotContains(t, body, "parent_public_id")
		subtasks, ok := body["subtasks"].([]any)
		require.True(t, ok, "subtasks must be a JSON array, got %#v", body["subtasks"])
		require.Len(t, subtasks, 2)
		assert.Equal(t, map[string]any{"public_id": older.PublicID, "title": older.Title}, subtasks[0])
		assert.Equal(t, map[string]any{"public_id": newer.PublicID, "title": newer.Title}, subtasks[1])
	})

	for _, subtask := range []tasks.TaskResponse{older, newer} {
		t.Run("subtask "+subtask.PublicID+" resolves to its parent", func(t *testing.T) {
			status, body := env.do(t, http.MethodGet, "/api/bot/v1/tasks/"+subtask.PublicID, env.token, nil)
			require.Equal(t, http.StatusOK, status)
			assert.Equal(t, subtask.PublicID, body["public_id"])
			assert.Equal(t, subtask.Title, body["title"])
			assert.Equal(t, parent.PublicID, body["parent_public_id"])
			subtasks, ok := body["subtasks"].([]any)
			require.True(t, ok, "subtasks must be a JSON array, got %#v", body["subtasks"])
			assert.Empty(t, subtasks)
		})
	}

	t.Run("task without subtasks has an empty array", func(t *testing.T) {
		status, body := env.do(t, http.MethodGet, "/api/bot/v1/tasks/"+childless.PublicID, env.token, nil)
		require.Equal(t, http.StatusOK, status)
		assert.NotContains(t, body, "parent_public_id")
		subtasks, ok := body["subtasks"].([]any)
		require.True(t, ok, "subtasks must be a JSON array, got %#v", body["subtasks"])
		assert.Empty(t, subtasks)
	})
}
