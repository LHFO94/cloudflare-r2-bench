package r2

import "testing"

// The naming scheme is duplicated in terraform/modules/r2/main.tf. These
// assertions pin the exact format so that a change here fails loudly rather
// than silently pointing the agent at buckets that do not exist.
func TestBucketNaming(t *testing.T) {
	n := Naming{BucketPrefix: "r2bench-lt1-", BucketCount: 25, KeyPrefix: "obj/", Keyspace: 40000}

	cases := map[int]string{
		0:  "r2bench-lt1-00",
		7:  "r2bench-lt1-07",
		24: "r2bench-lt1-24",
	}
	for i, want := range cases {
		if got := n.BucketName(i); got != want {
			t.Errorf("BucketName(%d) = %q, want %q", i, got, want)
		}
	}
}

func TestObjectKeyNaming(t *testing.T) {
	n := Naming{KeyPrefix: "obj/", Keyspace: 40000}

	cases := map[int]string{
		0:     "obj/00000000",
		1:     "obj/00000001",
		39999: "obj/00039999",
	}
	for i, want := range cases {
		if got := n.ObjectKey(i); got != want {
			t.Errorf("ObjectKey(%d) = %q, want %q", i, got, want)
		}
	}
}

// Zero padding must keep keys lexically sorted, which keeps ListObjects output
// predictable when debugging.
func TestObjectKeysAreLexicallyOrdered(t *testing.T) {
	n := Naming{KeyPrefix: "obj/"}
	prev := n.ObjectKey(0)
	for _, i := range []int{1, 9, 10, 99, 100, 9999, 10000, 99999999} {
		cur := n.ObjectKey(i)
		if cur <= prev {
			t.Fatalf("ObjectKey(%d)=%q is not lexically after %q", i, cur, prev)
		}
		prev = cur
	}
}

func TestSentinelIsInsideKeyPrefix(t *testing.T) {
	n := Naming{KeyPrefix: "obj/", Keyspace: 100}
	if got := n.SentinelKey(); got != "obj/_seed_complete" {
		t.Errorf("SentinelKey() = %q", got)
	}
	// The sentinel must not collide with a generated key.
	for i := 0; i < 1000; i++ {
		if n.ObjectKey(i) == n.SentinelKey() {
			t.Fatalf("sentinel collides with ObjectKey(%d)", i)
		}
	}
}

func TestSentinelBodyEncodesShape(t *testing.T) {
	a := Naming{KeyPrefix: "obj/", Keyspace: 40000}.SentinelBody(1536)
	b := Naming{KeyPrefix: "obj/", Keyspace: 40000}.SentinelBody(1536)
	if a != b {
		t.Error("sentinel body is not deterministic")
	}
	if c := (Naming{KeyPrefix: "obj/", Keyspace: 50000}).SentinelBody(1536); c == a {
		t.Error("sentinel body did not change with keyspace")
	}
	if d := (Naming{KeyPrefix: "obj/", Keyspace: 40000}).SentinelBody(2048); d == a {
		t.Error("sentinel body did not change with object size")
	}
}
