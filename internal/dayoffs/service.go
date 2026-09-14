package dayoffs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service owns database-backed dayoff rules, including mutation authorization.
// HTTP handlers must not make owner/admin authorization decisions themselves.
type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// ListMonth returns all active non-bot employees and records whose inclusive
// ranges intersect the requested calendar month.
func (s *Service) ListMonth(ctx context.Context, year, month int) (MonthResponse, error) {
	monthStart, monthEnd, err := calendarMonthBounds(year, month)
	if err != nil {
		return MonthResponse{}, err
	}
	yearStart, yearEnd := calendarYearBounds(year)

	result := MonthResponse{
		Employees:  make([]Employee, 0),
		Records:    make([]Dayoff, 0),
		YearTotals: make([]EmployeeYearTotal, 0),
	}
	totalIndexByEmployeeID := make(map[uuid.UUID]int)

	employees, err := s.pool.Query(ctx, `
		SELECT id,
		       COALESCE(NULLIF(btrim(display_name), ''), email) AS display_name,
		       avatar_url
		  FROM users
		 WHERE status = 'active'
		   AND role <> 'bot'
		 ORDER BY lower(COALESCE(NULLIF(btrim(display_name), ''), email)), id`)
	if err != nil {
		return MonthResponse{}, fmt.Errorf("dayoffs: list employees: %w", err)
	}
	defer employees.Close()

	for employees.Next() {
		var employee Employee
		if err := employees.Scan(&employee.ID, &employee.DisplayName, &employee.AvatarURL); err != nil {
			return MonthResponse{}, fmt.Errorf("dayoffs: scan employee: %w", err)
		}
		result.Employees = append(result.Employees, employee)
		totalIndexByEmployeeID[employee.ID] = len(result.YearTotals)
		result.YearTotals = append(result.YearTotals, EmployeeYearTotal{UserID: employee.ID})
	}
	if err := employees.Err(); err != nil {
		return MonthResponse{}, fmt.Errorf("dayoffs: iterate employees: %w", err)
	}

	totals, err := s.pool.Query(ctx, `
		SELECT d.user_id,
		       COALESCE(SUM(CASE WHEN d.leave_type = 'vacation'
		                         THEN LEAST(d.end_date, $2) - GREATEST(d.start_date, $1) + 1
		                         ELSE 0 END), 0)::int AS vacation_days,
		       COALESCE(SUM(CASE WHEN d.leave_type = 'sick_leave'
		                         THEN LEAST(d.end_date, $2) - GREATEST(d.start_date, $1) + 1
		                         ELSE 0 END), 0)::int AS sick_leave_days,
		       COALESCE(SUM(CASE WHEN d.leave_type = 'personal_day'
		                         THEN LEAST(d.end_date, $2) - GREATEST(d.start_date, $1) + 1
		                         ELSE 0 END), 0)::int AS personal_days
		  FROM dayoffs d
		  JOIN users u ON u.id = d.user_id
		 WHERE u.status = 'active'
		   AND u.role <> 'bot'
		   AND d.start_date <= $2
		   AND d.end_date >= $1
		 GROUP BY d.user_id`, yearStart, yearEnd)
	if err != nil {
		return MonthResponse{}, fmt.Errorf("dayoffs: list year totals: %w", err)
	}
	defer totals.Close()

	for totals.Next() {
		var total EmployeeYearTotal
		if err := totals.Scan(&total.UserID, &total.VacationDays, &total.SickLeaveDays, &total.PersonalDays); err != nil {
			return MonthResponse{}, fmt.Errorf("dayoffs: scan year total: %w", err)
		}
		if index, ok := totalIndexByEmployeeID[total.UserID]; ok {
			result.YearTotals[index] = total
		}
	}
	if err := totals.Err(); err != nil {
		return MonthResponse{}, fmt.Errorf("dayoffs: iterate year totals: %w", err)
	}

	records, err := s.pool.Query(ctx, `
		SELECT d.id, d.user_id, d.leave_type, d.start_date, d.end_date,
		       d.note, d.created_at, d.updated_at
		  FROM dayoffs d
		  JOIN users u ON u.id = d.user_id
		 WHERE u.status = 'active'
		   AND u.role <> 'bot'
		   AND d.start_date <= $2
		   AND d.end_date >= $1
		 ORDER BY lower(COALESCE(NULLIF(btrim(u.display_name), ''), u.email)),
		          d.start_date, d.end_date, d.id`, monthStart, monthEnd)
	if err != nil {
		return MonthResponse{}, fmt.Errorf("dayoffs: list records: %w", err)
	}
	defer records.Close()

	for records.Next() {
		record, err := scanDayoff(records)
		if err != nil {
			return MonthResponse{}, fmt.Errorf("dayoffs: scan record: %w", err)
		}
		result.Records = append(result.Records, record)
	}
	if err := records.Err(); err != nil {
		return MonthResponse{}, fmt.Errorf("dayoffs: iterate records: %w", err)
	}

	return result, nil
}

func (s *Service) Create(ctx context.Context, params CreateParams) (Dayoff, error) {
	input, err := validateMutation(params.Type, params.StartDate, params.EndDate, params.Note)
	if err != nil {
		return Dayoff{}, err
	}

	targetUserID, err := createTargetUserID(params.ActorID, params.ActorRole, params.UserID)
	if err != nil {
		return Dayoff{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Dayoff{}, fmt.Errorf("dayoffs: begin create transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := ensureActiveEmployee(ctx, tx, targetUserID); err != nil {
		return Dayoff{}, err
	}
	if err := ensureNoOverlap(ctx, tx, targetUserID, input.startDate, input.endDate, nil); err != nil {
		return Dayoff{}, err
	}

	record, err := scanDayoff(tx.QueryRow(ctx, `
		INSERT INTO dayoffs (user_id, leave_type, start_date, end_date, note)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, user_id, leave_type, start_date, end_date, note, created_at, updated_at`,
		targetUserID, input.leaveType, input.startDate, input.endDate, input.note,
	))
	if err != nil {
		return Dayoff{}, normalizeDatabaseError(fmt.Errorf("dayoffs: insert record: %w", err))
	}

	if err := tx.Commit(ctx); err != nil {
		return Dayoff{}, normalizeDatabaseError(fmt.Errorf("dayoffs: commit create transaction: %w", err))
	}
	return record, nil
}

func (s *Service) Update(ctx context.Context, id uuid.UUID, params UpdateParams) (Dayoff, error) {
	input, err := validateMutation(params.Type, params.StartDate, params.EndDate, params.Note)
	if err != nil {
		return Dayoff{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Dayoff{}, fmt.Errorf("dayoffs: begin update transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	existing, err := loadDayoffForUpdate(ctx, tx, id)
	if err != nil {
		return Dayoff{}, err
	}
	if !canManageRecord(params.ActorID, params.ActorRole, existing.UserID) {
		return Dayoff{}, fmt.Errorf("%w: cannot change another user's dayoff", ErrForbidden)
	}

	targetUserID := existing.UserID
	if params.UserID != nil {
		if !isElevatedRole(params.ActorRole) {
			return Dayoff{}, fmt.Errorf("%w: only admins can choose a record owner", ErrForbidden)
		}
		targetUserID = *params.UserID
	}
	if err := ensureActiveEmployee(ctx, tx, targetUserID); err != nil {
		return Dayoff{}, err
	}
	if err := ensureNoOverlap(ctx, tx, targetUserID, input.startDate, input.endDate, &id); err != nil {
		return Dayoff{}, err
	}

	record, err := scanDayoff(tx.QueryRow(ctx, `
		UPDATE dayoffs
		   SET user_id = $2,
		       leave_type = $3,
		       start_date = $4,
		       end_date = $5,
		       note = $6
		 WHERE id = $1
		RETURNING id, user_id, leave_type, start_date, end_date, note, created_at, updated_at`,
		id, targetUserID, input.leaveType, input.startDate, input.endDate, input.note,
	))
	if err != nil {
		return Dayoff{}, normalizeDatabaseError(fmt.Errorf("dayoffs: update record: %w", err))
	}
	if err := tx.Commit(ctx); err != nil {
		return Dayoff{}, normalizeDatabaseError(fmt.Errorf("dayoffs: commit update transaction: %w", err))
	}
	return record, nil
}

func (s *Service) Delete(ctx context.Context, id, actorID uuid.UUID, actorRole string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("dayoffs: begin delete transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	existing, err := loadDayoffForUpdate(ctx, tx, id)
	if err != nil {
		return err
	}
	if !canManageRecord(actorID, actorRole, existing.UserID) {
		return fmt.Errorf("%w: cannot delete another user's dayoff", ErrForbidden)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM dayoffs WHERE id = $1`, id); err != nil {
		return fmt.Errorf("dayoffs: delete record: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("dayoffs: commit delete transaction: %w", err)
	}
	return nil
}

type mutationInput struct {
	leaveType string
	startDate time.Time
	endDate   time.Time
	note      string
}

func validateMutation(leaveType, startDateRaw, endDateRaw, note string) (mutationInput, error) {
	leaveType = strings.ToLower(strings.TrimSpace(leaveType))
	if !isLeaveType(leaveType) {
		return mutationInput{}, fmt.Errorf("%w: type must be vacation, sick_leave, or personal_day", ErrBadRequest)
	}

	startDate, err := parseCalendarDate(startDateRaw, "start_date")
	if err != nil {
		return mutationInput{}, err
	}
	endDate, err := parseCalendarDate(endDateRaw, "end_date")
	if err != nil {
		return mutationInput{}, err
	}
	if endDate.Before(startDate) {
		return mutationInput{}, fmt.Errorf("%w: end_date must be on or after start_date", ErrBadRequest)
	}

	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > maxNoteLength {
		return mutationInput{}, fmt.Errorf("%w: note must be at most %d characters", ErrBadRequest, maxNoteLength)
	}

	return mutationInput{
		leaveType: leaveType,
		startDate: startDate,
		endDate:   endDate,
		note:      note,
	}, nil
}

func calendarMonthBounds(year, month int) (time.Time, time.Time, error) {
	if year < 1 || year > 9999 {
		return time.Time{}, time.Time{}, fmt.Errorf("%w: year must be between 1 and 9999", ErrBadRequest)
	}
	if month < int(time.January) || month > int(time.December) {
		return time.Time{}, time.Time{}, fmt.Errorf("%w: month must be between 1 and 12", ErrBadRequest)
	}
	start := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC)
	return start, start.AddDate(0, 1, -1), nil
}

func calendarYearBounds(year int) (time.Time, time.Time) {
	start := time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC)
	return start, start.AddDate(1, 0, -1)
}

func parseCalendarDate(raw, field string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, fmt.Errorf("%w: %s is required", ErrBadRequest, field)
	}
	parsed, err := time.Parse(time.DateOnly, raw)
	if err != nil || parsed.Format(time.DateOnly) != raw {
		return time.Time{}, fmt.Errorf("%w: %s must use YYYY-MM-DD", ErrBadRequest, field)
	}
	return parsed, nil
}

func isLeaveType(value string) bool {
	switch value {
	case TypeVacation, TypeSickLeave, TypePersonalDay:
		return true
	default:
		return false
	}
}

func createTargetUserID(actorID uuid.UUID, actorRole string, requested *uuid.UUID) (uuid.UUID, error) {
	if requested == nil {
		return actorID, nil
	}
	if !isElevatedRole(actorRole) {
		return uuid.Nil, fmt.Errorf("%w: only admins can choose a record owner", ErrForbidden)
	}
	return *requested, nil
}

func canManageRecord(actorID uuid.UUID, actorRole string, ownerID uuid.UUID) bool {
	return actorID == ownerID || isElevatedRole(actorRole)
}

func isElevatedRole(role string) bool {
	return role == "admin" || role == "owner"
}

func ensureActiveEmployee(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			  FROM users
			 WHERE id = $1
			   AND status = 'active'
			   AND role <> 'bot'
		)`, userID).Scan(&exists); err != nil {
		return fmt.Errorf("dayoffs: verify record owner: %w", err)
	}
	if !exists {
		return fmt.Errorf("%w: active employee", ErrNotFound)
	}
	return nil
}

func ensureNoOverlap(ctx context.Context, tx pgx.Tx, userID uuid.UUID, startDate, endDate time.Time, excludedID *uuid.UUID) error {
	excluded := uuid.NullUUID{}
	if excludedID != nil {
		excluded = uuid.NullUUID{UUID: *excludedID, Valid: true}
	}

	var conflictingID uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id
		  FROM dayoffs
		 WHERE user_id = $1
		   AND start_date <= $3
		   AND end_date >= $2
		   AND ($4::uuid IS NULL OR id <> $4)
		 LIMIT 1
		 FOR UPDATE`, userID, startDate, endDate, excluded).Scan(&conflictingID)
	if err == nil {
		return fmt.Errorf("%w: date range overlaps an existing record", ErrConflict)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return fmt.Errorf("dayoffs: check date overlap: %w", err)
}

func loadDayoffForUpdate(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Dayoff, error) {
	record, err := scanDayoff(tx.QueryRow(ctx, `
		SELECT id, user_id, leave_type, start_date, end_date, note, created_at, updated_at
		  FROM dayoffs
		 WHERE id = $1
		 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Dayoff{}, fmt.Errorf("%w: dayoff record", ErrNotFound)
	}
	if err != nil {
		return Dayoff{}, fmt.Errorf("dayoffs: load record: %w", err)
	}
	return record, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanDayoff(row rowScanner) (Dayoff, error) {
	var (
		record    Dayoff
		startDate time.Time
		endDate   time.Time
	)
	if err := row.Scan(
		&record.ID,
		&record.UserID,
		&record.Type,
		&startDate,
		&endDate,
		&record.Note,
		&record.CreatedAt,
		&record.UpdatedAt,
	); err != nil {
		return Dayoff{}, err
	}
	record.StartDate = dateFromTime(startDate)
	record.EndDate = dateFromTime(endDate)
	return record, nil
}

func normalizeDatabaseError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23P01": // exclusion violation
		return fmt.Errorf("%w: date range overlaps an existing record", ErrConflict)
	case "23514": // check violation
		return fmt.Errorf("%w: invalid dayoff record", ErrBadRequest)
	case "23503": // foreign key violation
		return fmt.Errorf("%w: active employee", ErrNotFound)
	default:
		return err
	}
}
