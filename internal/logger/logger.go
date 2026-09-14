package logger

import (
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var Logger *zap.Logger

func Init(dev bool) error {
	var cfg zap.Config

	if dev {
		cfg = zap.NewDevelopmentConfig()
		cfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	} else {
		cfg = zap.NewProductionConfig()
		cfg.EncoderConfig.TimeKey = "timestamp"
		cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	}

	var err error
	Logger, err = cfg.Build(zap.AddCallerSkip(0))
	if err != nil {
		return err
	}

	return nil
}

func Sync() {
	if Logger != nil {
		Logger.Sync()
	}
}
