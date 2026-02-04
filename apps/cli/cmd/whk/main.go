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
	"bufio"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"webhooks.cc/cli/internal/api"
	"webhooks.cc/cli/internal/auth"
	"webhooks.cc/cli/internal/stream"
	"webhooks.cc/cli/internal/tunnel"
	"webhooks.cc/shared/types"
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

	authCmd.AddCommand(authLoginCmd())
	authCmd.AddCommand(authStatusCmd())
	authCmd.AddCommand(authLogoutCmd())

	// Endpoint commands
	createCmd := createEndpointCmd()
	listCmd := listEndpointsCmd()
	deleteCmd := deleteEndpointCmd()

	// Tunnel command
	tunnelCmd := tunnelCmd()

	// Listen command
	listenCmd := listenCmd()

	// Replay command
	replayCmd := replayCmd()

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

// --- Auth commands ---

func authLoginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Log in to webhooks.cc",
		RunE: func(cmd *cobra.Command, args []string) error {
			client := api.NewClient()
			ctx, cancel := context.WithCancel(cmd.Context())
			defer cancel()

			// Handle Ctrl+C
			sigCh := make(chan os.Signal, 1)
			signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
			defer signal.Stop(sigCh)
			go func() {
				select {
				case <-sigCh:
					fmt.Println("\nLogin cancelled.")
					cancel()
				case <-ctx.Done():
				}
			}()

			// Create device code
			resp, err := client.CreateDeviceCode(ctx)
			if err != nil {
				return fmt.Errorf("failed to start login: %w", err)
			}

			fmt.Println()
			fmt.Printf("  Your code: %s\n", resp.UserCode)
			fmt.Println()
			fmt.Printf("  Open this URL to authorize: %s\n", resp.VerificationURL)
			fmt.Println()

			// Try to open browser
			if err := openBrowser(resp.VerificationURL); err == nil {
				fmt.Println("  Browser opened. Waiting for authorization...")
			} else {
				fmt.Println("  Waiting for authorization...")
			}
			fmt.Println()

			// Poll every 5 seconds
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()

			for {
				select {
				case <-ctx.Done():
					return fmt.Errorf("login cancelled")
				case <-ticker.C:
					poll, err := client.PollDeviceCode(ctx, resp.DeviceCode)
					if err != nil {
						continue
					}

					switch poll.Status {
					case "authorized":
						// Claim the API key
						claim, err := client.ClaimDeviceCode(ctx, resp.DeviceCode)
						if err != nil {
							return fmt.Errorf("failed to claim token: %w", err)
						}

						// Save the token
						if err := auth.SaveToken(&auth.Token{
							AccessToken: claim.APIKey,
							UserID:      claim.UserID,
							Email:       claim.Email,
						}); err != nil {
							return fmt.Errorf("failed to save token: %w", err)
						}

						fmt.Printf("  Logged in as %s\n", claim.Email)
						return nil

					case "expired":
						return fmt.Errorf("code expired, please run 'whk auth login' again")
					}
				}
			}
		},
	}
}

func authStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show current authentication status",
		Run: func(cmd *cobra.Command, args []string) {
			token, err := auth.LoadToken()
			if err != nil || token.AccessToken == "" {
				fmt.Println("Not logged in")
				fmt.Println("Run 'whk auth login' to authenticate")
				return
			}
			fmt.Printf("Logged in as %s\n", token.Email)
		},
	}
}

func authLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Log out of webhooks.cc",
		Run: func(cmd *cobra.Command, args []string) {
			if err := auth.ClearToken(); err != nil {
				fmt.Println("Already logged out")
				return
			}
			fmt.Println("Logged out")
		},
	}
}

// --- Endpoint commands ---

func createEndpointCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "create [name]",
		Short: "Create a new endpoint",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := ""
			if len(args) > 0 {
				name = args[0]
			}

			client := api.NewClient()
			endpoint, err := client.CreateEndpoint(name)
			if err != nil {
				return err
			}

			webhookURL := client.BaseURL()
			// Use NEXT_PUBLIC_WEBHOOK_URL pattern if available
			if envURL := os.Getenv("WHK_WEBHOOK_URL"); envURL != "" {
				webhookURL = envURL
			}

			fmt.Printf("Endpoint created: %s\n", endpoint.Slug)
			fmt.Printf("URL: %s/w/%s\n", webhookURL, endpoint.Slug)
			return nil
		},
	}
}

func listEndpointsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List your endpoints",
		RunE: func(cmd *cobra.Command, args []string) error {
			client := api.NewClient()
			endpoints, err := client.ListEndpoints()
			if err != nil {
				return err
			}

			if len(endpoints) == 0 {
				fmt.Println("No endpoints found")
				fmt.Println("Run 'whk create [name]' to create one")
				return nil
			}

			webhookURL := client.BaseURL()
			if envURL := os.Getenv("WHK_WEBHOOK_URL"); envURL != "" {
				webhookURL = envURL
			}

			fmt.Printf("%-10s %-20s %s\n", "SLUG", "NAME", "URL")
			fmt.Printf("%-10s %-20s %s\n", "----", "----", "---")
			for _, ep := range endpoints {
				name := ep.Name
				if name == "" {
					name = "-"
				}
				fmt.Printf("%-10s %-20s %s/w/%s\n", ep.Slug, name, webhookURL, ep.Slug)
			}
			return nil
		},
	}
}

func deleteEndpointCmd() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "delete <slug>",
		Short: "Delete an endpoint",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug := args[0]

			if !force {
				fmt.Printf("Delete endpoint '%s'? This cannot be undone. [y/N] ", slug)
				reader := bufio.NewReader(os.Stdin)
				answer, _ := reader.ReadString('\n')
				answer = strings.TrimSpace(strings.ToLower(answer))
				if answer != "y" && answer != "yes" {
					fmt.Println("Cancelled")
					return nil
				}
			}

			client := api.NewClient()
			if err := client.DeleteEndpoint(slug); err != nil {
				return err
			}

			fmt.Printf("Endpoint '%s' deleted\n", slug)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&force, "force", "f", false, "Skip confirmation prompt")
	return cmd
}

// --- Tunnel command ---

func tunnelCmd() *cobra.Command {
	var (
		endpointSlug string
		ephemeral    bool
		headers      []string
	)

	cmd := &cobra.Command{
		Use:   "tunnel <port>",
		Short: "Create an endpoint and forward requests to localhost",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			// Validate port
			portNum, err := strconv.Atoi(args[0])
			if err != nil || portNum < 1 || portNum > 65535 {
				return fmt.Errorf("invalid port: %s (must be 1-65535)", args[0])
			}
			targetURL := fmt.Sprintf("http://localhost:%d", portNum)

			// Check auth early before making any API calls
			token, err := auth.LoadToken()
			if err != nil {
				return fmt.Errorf("not logged in: %w", err)
			}

			client := api.NewClient()

			ctx, cancel := context.WithCancel(cmd.Context())
			defer cancel()

			sigCh := make(chan os.Signal, 1)
			signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
			defer signal.Stop(sigCh)

			// Create or reuse endpoint
			slug := endpointSlug
			createdEndpoint := false
			if slug == "" {
				endpoint, err := client.CreateEndpointWithContext(ctx, "")
				if err != nil {
					return fmt.Errorf("failed to create endpoint: %w", err)
				}
				slug = endpoint.Slug
				createdEndpoint = true
			}

			webhookURL := client.BaseURL()
			if envURL := os.Getenv("WHK_WEBHOOK_URL"); envURL != "" {
				webhookURL = envURL
			}

			fmt.Printf("Forwarding %s/w/%s -> %s\n", webhookURL, slug, targetURL)
			if ephemeral && createdEndpoint {
				fmt.Println("Endpoint will be deleted on exit")
			}
			fmt.Println("Press Ctrl+C to stop")
			fmt.Println()

			// Set up tunnel forwarder
			t := tunnel.New(slug, targetURL)

			// Apply custom headers
			customHeaders := parseHeaders(headers)

			// Set up SSE stream
			s := stream.New(slug, client.BaseURL(), token.AccessToken)

			// Handle cleanup on exit
			go func() {
				select {
				case <-sigCh:
					fmt.Println("\nShutting down...")
					if ephemeral && createdEndpoint {
						delCtx, delCancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer delCancel()
						if delErr := client.DeleteEndpointWithContext(delCtx, slug); delErr != nil {
							fmt.Fprintf(os.Stderr, "Warning: failed to delete endpoint: %v\n", delErr)
						} else {
							fmt.Println("Endpoint deleted")
						}
					}
					cancel()
				case <-ctx.Done():
				}
			}()

			// Listen for requests and forward them
			return s.Listen(ctx, func(req *types.CapturedRequest) {
				// Print received request
				fmt.Printf("  %s", stream.FormatRequest(req))

				// Apply custom headers
				for k, v := range customHeaders {
					req.Headers[k] = v
				}

				// Forward to local server
				result, err := t.Forward(req)
				if err != nil {
					fmt.Printf("  -> ERROR: %v\n", err)
					return
				}
				fmt.Printf("  -> %s\n", result)
			})
		},
	}

	cmd.Flags().StringVar(&endpointSlug, "endpoint", "", "Use an existing endpoint instead of creating one")
	cmd.Flags().BoolVarP(&ephemeral, "ephemeral", "e", false, "Delete endpoint on exit")
	cmd.Flags().StringArrayVarP(&headers, "header", "H", nil, "Add custom header to forwarded requests (repeatable, format: Key:Value)")

	return cmd
}

// --- Listen command ---

func listenCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "listen <slug>",
		Short: "Stream incoming requests to terminal",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug := args[0]
			client := api.NewClient()

			ctx, cancel := context.WithCancel(cmd.Context())
			defer cancel()

			sigCh := make(chan os.Signal, 1)
			signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
			defer signal.Stop(sigCh)
			go func() {
				select {
				case <-sigCh:
					fmt.Println("\nStopped listening")
					cancel()
				case <-ctx.Done():
				}
			}()

			token, err := auth.LoadToken()
			if err != nil {
				return fmt.Errorf("not logged in: %w", err)
			}

			webhookURL := client.BaseURL()
			if envURL := os.Getenv("WHK_WEBHOOK_URL"); envURL != "" {
				webhookURL = envURL
			}

			fmt.Printf("Listening on %s/w/%s\n", webhookURL, slug)
			fmt.Println("Press Ctrl+C to stop")
			fmt.Println()

			s := stream.New(slug, client.BaseURL(), token.AccessToken)
			return s.Listen(ctx, func(req *types.CapturedRequest) {
				fmt.Printf("  %s\n", stream.FormatRequest(req))
			})
		},
	}
}

// --- Replay command ---

func replayCmd() *cobra.Command {
	var target string

	cmd := &cobra.Command{
		Use:   "replay <request-id>",
		Short: "Replay a captured request",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			requestID := args[0]
			client := api.NewClient()

			ctx := cmd.Context()

			// Fetch the request
			req, err := client.GetRequest(ctx, requestID)
			if err != nil {
				return fmt.Errorf("failed to fetch request: %w", err)
			}

			fmt.Printf("Replaying %s %s -> %s\n", req.Method, req.Path, target)

			// Forward to target
			t := tunnel.New("", target)
			result, fwdErr := t.Forward(req)
			if fwdErr != nil {
				return fmt.Errorf("replay failed: %w", fwdErr)
			}

			fmt.Printf("Result: %s\n", result)
			return nil
		},
	}

	cmd.Flags().StringVar(&target, "to", "http://localhost:8080", "Target URL for replay")
	return cmd
}

// --- Helpers ---

func openBrowser(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("refusing to open non-HTTP URL scheme: %s", parsed.Scheme)
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", rawURL)
	case "linux":
		cmd = exec.Command("xdg-open", rawURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	default:
		return fmt.Errorf("unsupported platform")
	}
	return cmd.Start()
}

func parseHeaders(headers []string) map[string]string {
	result := make(map[string]string)
	for _, h := range headers {
		parts := strings.SplitN(h, ":", 2)
		if len(parts) == 2 {
			result[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
	}
	return result
}
