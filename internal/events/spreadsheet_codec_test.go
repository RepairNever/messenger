package events

import (
	"github.com/stretchr/testify/require"
	packetspb "msgnr/internal/gen/proto"
	"testing"
	"time"
)

func TestSpreadsheetEventCodecPreservesAuthoredPatchesAndClear(t *testing.T) {
	event, err := buildServerEventFromStored("spreadsheet_changed", "event", "", time.Now(), []byte(`{"documentId":"document","actorId":"actor","operationId":"operation","revision":"7","structureEpoch":"2","kind":"cells","cells":[{"sheetId":"sheet","row":3,"col":4,"cellJson":"{\"f\":\"=A1*2\",\"s\":{\"bl\":1}}"},{"sheetId":"sheet","row":4,"col":4,"clear":true}]}`))
	require.NoError(t, err)
	require.NoError(t, ValidateEventTypePayload("spreadsheet_changed", event))
	payload := event.GetSpreadsheetChanged()
	require.NotNil(t, payload)
	require.Equal(t, int64(7), payload.Revision)
	require.Equal(t, int64(2), payload.StructureEpoch)
	require.Equal(t, "document", payload.DocumentId)
	require.Len(t, payload.Cells, 2)
	require.JSONEq(t, `{"f":"=A1*2","s":{"bl":1}}`, payload.Cells[0].CellJson)
	require.True(t, payload.Cells[1].Clear)
	require.Error(t, ValidateEventTypePayload("spreadsheet_changed", &packetspb.ServerEvent{EventType: packetspb.EventType_EVENT_TYPE_SPREADSHEET_CHANGED}))
}
