//go:build integration

package dayoffs_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/dayoffs"
	"msgnr/internal/testdb"
)

func seedDayoffUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, displayName, role, status string) uuid.UUID {
	t.Helper()
	if role == "" {
		role = "member"
	}
	if status == "" {
		status = "active"
	}

	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, display_name, role, status)
		VALUES ($1, 'x', $2, $3, $4)
		RETURNING id`,
		"dayoffs_test_"+uuid.NewString()+"@example.com",
		displayName,
		role,
		status,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func uuidPtr(value uuid.UUID) *uuid.UUID {
	return &value
}

func createDayoff(t *testing.T, ctx context.Context, svc *dayoffs.Service, userID uuid.UUID, role, leaveType, startDate, endDate string) dayoffs.Dayoff {
	t.Helper()
	record, err := svc.Create(ctx, dayoffs.CreateParams{
		Type:      leaveType,
		StartDate: startDate,
		EndDate:   endDate,
		ActorID:   userID,
		ActorRole: role,
	})
	require.NoError(t, err)
	return record
}

func TestIntegration_ListMonthIncludesActiveEmployeesAndIntersectingRanges(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := dayoffs.NewService(pool)

	aliceID := seedDayoffUser(t, ctx, pool, "Alice", "member", "active")
	bobID := seedDayoffUser(t, ctx, pool, "Bob", "member", "active")
	blockedID := seedDayoffUser(t, ctx, pool, "Blocked", "member", "blocked")
	botID := seedDayoffUser(t, ctx, pool, "Calendar bot", "bot", "active")

	aliceRange := createDayoff(t, ctx, svc, aliceID, "member", dayoffs.TypeVacation, "2026-07-30", "2026-08-02")
	_ = createDayoff(t, ctx, svc, bobID, "member", dayoffs.TypeSickLeave, "2026-09-01", "2026-09-02")

	// These rows represent legacy/inactive accounts. The shared calendar must
	// not expose them, even if old records remain in the database.
	_, err := pool.Exec(ctx, `
		INSERT INTO dayoffs (user_id, leave_type, start_date, end_date)
		VALUES ($1, 'personal_day', DATE '2026-08-10', DATE '2026-08-10'),
		       ($2, 'personal_day', DATE '2026-08-11', DATE '2026-08-11')`,
		blockedID, botID)
	require.NoError(t, err)

	response, err := svc.ListMonth(ctx, 2026, 8)
	require.NoError(t, err)
	require.Len(t, response.Employees, 2)
	assert.Equal(t, []uuid.UUID{aliceID, bobID}, []uuid.UUID{response.Employees[0].ID, response.Employees[1].ID})
	require.Len(t, response.Records, 1)
	assert.Equal(t, aliceRange.ID, response.Records[0].ID)
	assert.Equal(t, "2026-07-30", response.Records[0].StartDate.String())
	assert.Equal(t, "2026-08-02", response.Records[0].EndDate.String())
	require.Len(t, response.YearTotals, 2)
	assert.Equal(t, dayoffs.EmployeeYearTotal{
		UserID:       aliceID,
		VacationDays: 4,
	}, response.YearTotals[0])
	assert.Equal(t, dayoffs.EmployeeYearTotal{
		UserID:        bobID,
		SickLeaveDays: 2,
	}, response.YearTotals[1])
}

func TestIntegration_ListMonthYearTotalsUseCalendarDaysWithinTheSelectedYear(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := dayoffs.NewService(pool)

	aliceID := seedDayoffUser(t, ctx, pool, "Alice", "member", "active")
	bobID := seedDayoffUser(t, ctx, pool, "Bob", "member", "active")
	_ = createDayoff(t, ctx, svc, aliceID, "member", dayoffs.TypeVacation, "2026-01-10", "2026-01-12")
	_ = createDayoff(t, ctx, svc, aliceID, "member", dayoffs.TypeSickLeave, "2026-02-01", "2026-02-01")
	_ = createDayoff(t, ctx, svc, aliceID, "member", dayoffs.TypePersonalDay, "2026-12-30", "2027-01-02")

	response, err := svc.ListMonth(ctx, 2026, 7)
	require.NoError(t, err)
	require.Len(t, response.Records, 0)
	require.Len(t, response.YearTotals, 2)
	assert.Equal(t, dayoffs.EmployeeYearTotal{
		UserID:        aliceID,
		VacationDays:  3,
		SickLeaveDays: 1,
		PersonalDays:  2,
	}, response.YearTotals[0])
	assert.Equal(t, dayoffs.EmployeeYearTotal{UserID: bobID}, response.YearTotals[1])

	nextYearResponse, err := svc.ListMonth(ctx, 2027, 1)
	require.NoError(t, err)
	require.Len(t, nextYearResponse.YearTotals, 2)
	assert.Equal(t, dayoffs.EmployeeYearTotal{
		UserID:       aliceID,
		PersonalDays: 2,
	}, nextYearResponse.YearTotals[0])
}

func TestIntegration_CreateValidatesRangesAndRejectsInclusiveOverlaps(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := dayoffs.NewService(pool)
	aliceID := seedDayoffUser(t, ctx, pool, "Alice", "member", "active")

	created, err := svc.Create(ctx, dayoffs.CreateParams{
		Type:      dayoffs.TypeVacation,
		StartDate: "2026-07-10",
		EndDate:   "2026-07-12",
		Note:      "  family trip  ",
		ActorID:   aliceID,
		ActorRole: "member",
	})
	require.NoError(t, err)
	assert.Equal(t, "family trip", created.Note)

	_, err = svc.Create(ctx, dayoffs.CreateParams{
		Type:      "unpaid_leave",
		StartDate: "2026-07-20",
		EndDate:   "2026-07-20",
		ActorID:   aliceID,
		ActorRole: "member",
	})
	require.ErrorIs(t, err, dayoffs.ErrBadRequest)

	_, err = svc.Create(ctx, dayoffs.CreateParams{
		Type:      dayoffs.TypeSickLeave,
		StartDate: "2026-07-20",
		EndDate:   "2026-07-19",
		ActorID:   aliceID,
		ActorRole: "member",
	})
	require.ErrorIs(t, err, dayoffs.ErrBadRequest)

	_, err = svc.Create(ctx, dayoffs.CreateParams{
		Type:      dayoffs.TypeSickLeave,
		StartDate: "2026-7-20",
		EndDate:   "2026-07-20",
		ActorID:   aliceID,
		ActorRole: "member",
	})
	require.ErrorIs(t, err, dayoffs.ErrBadRequest)

	_, err = svc.Create(ctx, dayoffs.CreateParams{
		Type:      dayoffs.TypePersonalDay,
		StartDate: "2026-07-12", // the existing inclusive end date
		EndDate:   "2026-07-14",
		ActorID:   aliceID,
		ActorRole: "member",
	})
	require.ErrorIs(t, err, dayoffs.ErrConflict)
}

func TestIntegration_MembersCanOnlyManageTheirOwnRecords(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := dayoffs.NewService(pool)
	aliceID := seedDayoffUser(t, ctx, pool, "Alice", "member", "active")
	bobID := seedDayoffUser(t, ctx, pool, "Bob", "member", "active")

	record := createDayoff(t, ctx, svc, aliceID, "member", dayoffs.TypeVacation, "2026-07-10", "2026-07-12")

	_, err := svc.Create(ctx, dayoffs.CreateParams{
		UserID:    uuidPtr(aliceID),
		Type:      dayoffs.TypeSickLeave,
		StartDate: "2026-07-20",
		EndDate:   "2026-07-20",
		ActorID:   bobID,
		ActorRole: "member",
	})
	require.ErrorIs(t, err, dayoffs.ErrForbidden)

	_, err = svc.Update(ctx, record.ID, dayoffs.UpdateParams{
		Type:      dayoffs.TypeSickLeave,
		StartDate: "2026-07-10",
		EndDate:   "2026-07-12",
		ActorID:   bobID,
		ActorRole: "member",
	})
	require.ErrorIs(t, err, dayoffs.ErrForbidden)

	err = svc.Delete(ctx, record.ID, bobID, "member")
	require.ErrorIs(t, err, dayoffs.ErrForbidden)

	updated, err := svc.Update(ctx, record.ID, dayoffs.UpdateParams{
		Type:      dayoffs.TypeSickLeave,
		StartDate: "2026-07-11",
		EndDate:   "2026-07-13",
		ActorID:   aliceID,
		ActorRole: "member",
	})
	require.NoError(t, err)
	assert.Equal(t, dayoffs.TypeSickLeave, updated.Type)
}

func TestIntegration_AdminAndOwnerCanManageAnyRecordAndDeleteHard(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := dayoffs.NewService(pool)
	aliceID := seedDayoffUser(t, ctx, pool, "Alice", "member", "active")
	bobID := seedDayoffUser(t, ctx, pool, "Bob", "member", "active")
	adminID := seedDayoffUser(t, ctx, pool, "Admin", "admin", "active")
	ownerID := seedDayoffUser(t, ctx, pool, "Owner", "owner", "active")

	record, err := svc.Create(ctx, dayoffs.CreateParams{
		UserID:    uuidPtr(aliceID),
		Type:      dayoffs.TypeVacation,
		StartDate: "2026-08-03",
		EndDate:   "2026-08-05",
		ActorID:   adminID,
		ActorRole: "admin",
	})
	require.NoError(t, err)
	assert.Equal(t, aliceID, record.UserID)

	updated, err := svc.Update(ctx, record.ID, dayoffs.UpdateParams{
		UserID:    uuidPtr(bobID),
		Type:      dayoffs.TypePersonalDay,
		StartDate: "2026-08-04",
		EndDate:   "2026-08-04",
		Note:      "Owner correction",
		ActorID:   ownerID,
		ActorRole: "owner",
	})
	require.NoError(t, err)
	assert.Equal(t, bobID, updated.UserID)
	assert.Equal(t, dayoffs.TypePersonalDay, updated.Type)

	require.NoError(t, svc.Delete(ctx, updated.ID, adminID, "admin"))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM dayoffs WHERE id = $1`, updated.ID).Scan(&count))
	assert.Zero(t, count)
}
