package webhookscc

// Field is one setting in an update. The zero value leaves the setting as it
// is; Value sets it and Null clears it.
//
//	client.Endpoints.Update(ctx, slug, webhookscc.UpdateEndpointOptions{
//		Name:         webhookscc.Value("checkout tests"),
//		MockResponse: webhookscc.Null[webhookscc.MockResponse](),
//	})
type Field[T any] struct {
	value T
	set   bool
	null  bool
}

// Value sets a setting to v.
func Value[T any](v T) Field[T] { return Field[T]{value: v, set: true} }

// Null clears a setting.
func Null[T any]() Field[T] { return Field[T]{set: true, null: true} }

// IsSet reports whether the update changes this setting.
func (f Field[T]) IsSet() bool { return f.set }

// put adds the setting to an update body when it is set.
func (f Field[T]) put(body map[string]any, key string) {
	switch {
	case !f.set:
	case f.null:
		body[key] = nil
	default:
		body[key] = f.value
	}
}
