package r2

import "fmt"

// Naming defines the bucket and key layout for a benchmark deployment.
//
// The agent, the seeder and the Terraform r2 module must all agree on this
// scheme. Terraform generates bucket names with the same format string; if you
// change it here, change it in terraform/modules/r2/main.tf too.
type Naming struct {
	BucketPrefix string
	BucketCount  int
	KeyPrefix    string
	Keyspace     int
}

// BucketName returns the bucket for index i, zero-padded to two digits so that
// lexical and numeric ordering agree (r2bench-00 .. r2bench-24).
func (n Naming) BucketName(i int) string {
	return fmt.Sprintf("%s%02d", n.BucketPrefix, i)
}

// ObjectKey returns the key for index i, zero-padded to eight digits.
func (n Naming) ObjectKey(i int) string {
	return fmt.Sprintf("%s%08d", n.KeyPrefix, i)
}

// SentinelKey is written by the seeder once a bucket is fully populated. Its
// presence and contents let a re-run skip buckets that already match the
// requested shape, which matters because every PUT is a billable Class A
// operation.
func (n Naming) SentinelKey() string {
	return n.KeyPrefix + "_seed_complete"
}

// SentinelBody encodes the shape a bucket was seeded with.
func (n Naming) SentinelBody(objectSize int) string {
	return fmt.Sprintf("keyspace=%d\nobject_size=%d\nkey_prefix=%s\n", n.Keyspace, objectSize, n.KeyPrefix)
}
