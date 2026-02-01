// Package main provides the whk command-line tool for webhooks.cc.
// Commands:
//   - auth: Login, logout, check authentication status
//   - create: Create a new webhook endpoint
//   - list: List your endpoints
//   - delete: Delete an endpoint by slug
//   - tunnel: Forward webhooks to localhost
//   - listen: Stream incoming requests to terminal
//   - replay: Resend a captured request to a target URL
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var version = "dev"

func main() {
	rootCmd := &cobra.Command{
		Use:     "whk",
		Short:   "webhooks.cc CLI - Inspect and forward webhooks",
		Version: version,
	}

	// Auth commands
	authCmd := &cobra.Command{
		Use:   "auth",
		Short: "Authentication commands",
	}

	authCmd.AddCommand(&cobra.Command{
		Use:   "login",
		Short: "Log in to webhooks.cc",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Println("Opening browser for authentication...")
			// TODO: Implement OAuth device flow
			fmt.Println("Authentication not yet implemented")
		},
	})

	authCmd.AddCommand(&cobra.Command{
		Use:   "logout",
		Short: "Log out of webhooks.cc",
		Run: func(cmd *cobra.Command, args []string) {
			// TODO: Clear stored credentials
			fmt.Println("Logged out")
		},
	})

	authCmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show current authentication status",
		Run: func(cmd *cobra.Command, args []string) {
			// TODO: Check stored credentials
			fmt.Println("Not logged in")
		},
	})

	// Endpoint commands
	createCmd := &cobra.Command{
		Use:   "create [name]",
		Short: "Create a new endpoint",
		Args:  cobra.MaximumNArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			name := ""
			if len(args) > 0 {
				name = args[0]
			}
			fmt.Printf("Creating endpoint: %s\n", name)
			// TODO: Call Convex to create endpoint
			fmt.Println("Endpoint creation not yet implemented")
		},
	}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List your endpoints",
		Run: func(cmd *cobra.Command, args []string) {
			// TODO: Fetch endpoints from Convex
			fmt.Println("Endpoint listing not yet implemented")
		},
	}

	deleteCmd := &cobra.Command{
		Use:   "delete <slug>",
		Short: "Delete an endpoint",
		Args:  cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			slug := args[0]
			fmt.Printf("Deleting endpoint: %s\n", slug)
			// TODO: Call Convex to delete endpoint
			fmt.Println("Endpoint deletion not yet implemented")
		},
	}

	// Tunnel command (the killer feature)
	tunnelCmd := &cobra.Command{
		Use:   "tunnel <port>",
		Short: "Create an endpoint and forward requests to localhost",
		Args:  cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			port := args[0]
			subdomain, _ := cmd.Flags().GetString("subdomain")
			ephemeral, _ := cmd.Flags().GetBool("ephemeral")

			fmt.Printf("Creating tunnel to localhost:%s\n", port)
			if subdomain != "" {
				fmt.Printf("Requesting subdomain: %s\n", subdomain)
			}
			if ephemeral {
				fmt.Println("Endpoint will be deleted on exit")
			}

			// TODO: Create endpoint, connect to real-time stream, forward requests
			fmt.Println("Tunneling not yet implemented")
		},
	}
	tunnelCmd.Flags().StringP("subdomain", "s", "", "Request specific subdomain (pro only)")
	tunnelCmd.Flags().BoolP("ephemeral", "e", false, "Delete endpoint on exit")

	// Listen command
	listenCmd := &cobra.Command{
		Use:   "listen <slug>",
		Short: "Stream incoming requests to terminal",
		Args:  cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			slug := args[0]
			fmt.Printf("Listening on endpoint: %s\n", slug)
			// TODO: Connect to real-time stream
			fmt.Println("Listening not yet implemented")
		},
	}

	// Replay command
	replayCmd := &cobra.Command{
		Use:   "replay <request-id>",
		Short: "Replay a captured request",
		Args:  cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			requestID := args[0]
			target, _ := cmd.Flags().GetString("to")

			fmt.Printf("Replaying request %s to %s\n", requestID, target)
			// TODO: Fetch request from Convex and replay
			fmt.Println("Replay not yet implemented")
		},
	}
	replayCmd.Flags().String("to", "http://localhost:8080", "Target URL for replay")

	// Add all commands
	rootCmd.AddCommand(authCmd)
	rootCmd.AddCommand(createCmd)
	rootCmd.AddCommand(listCmd)
	rootCmd.AddCommand(deleteCmd)
	rootCmd.AddCommand(tunnelCmd)
	rootCmd.AddCommand(listenCmd)
	rootCmd.AddCommand(replayCmd)

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
