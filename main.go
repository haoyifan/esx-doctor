package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	args := append([]string{"run", "./cmd/esx-doctor"}, os.Args[1:]...)
	cmd := exec.Command("go", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "failed to run app: %v\n", err)
		os.Exit(1)
	}
}
