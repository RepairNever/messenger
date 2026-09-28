package botapi

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"msgnr/internal/config"
)

func testConfig() *config.Config {
	return &config.Config{
		BotAPIEnabled:            true,
		BotAPIMaxWaitSeconds:     30,
		BotAPIEventsMaxLimit:     500,
		BotAPIRateLimitRPS:       10,
		BotAPIRateLimitBurst:     20,
		BotAPIMaxConcurrentPolls: 2,
	}
}

func TestTestConfigDefaults(t *testing.T) {
	// Guards the helper against silent drift from the shipped defaults.
	cfg, err := config.Load()
	assert.NoError(t, err)
	assert.Equal(t, testConfig().BotAPIEnabled, cfg.BotAPIEnabled)
	assert.Equal(t, testConfig().BotAPIMaxWaitSeconds, cfg.BotAPIMaxWaitSeconds)
	assert.Equal(t, testConfig().BotAPIEventsMaxLimit, cfg.BotAPIEventsMaxLimit)
	assert.Equal(t, testConfig().BotAPIRateLimitRPS, cfg.BotAPIRateLimitRPS)
	assert.Equal(t, testConfig().BotAPIRateLimitBurst, cfg.BotAPIRateLimitBurst)
	assert.Equal(t, testConfig().BotAPIMaxConcurrentPolls, cfg.BotAPIMaxConcurrentPolls)
}
