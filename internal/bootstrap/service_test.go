package bootstrap

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"msgnr/internal/config"
)

func TestClampPageSize_EnforcesMinimumWhenConfigIsZero(t *testing.T) {
	svc := &Service{
		cfg: &config.Config{
			BootstrapDefaultPageSize: 0,
			BootstrapMaxPageSize:     0,
		},
	}

	assert.Equal(t, 1, svc.clampPageSize(0))
	assert.Equal(t, 1, svc.clampPageSize(1))
}
