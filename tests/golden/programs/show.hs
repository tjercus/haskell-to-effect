module Main where

data Op = Plus | Minus deriving Show
data Expr = Num Int | BinOp Op Expr Expr | Neg Expr deriving Show
data Pair a b = Pair a b deriving Show

main :: IO ()
main = do
  print (-5)
  print [Just (-1), Nothing]
  print (Left 3 :: Either Int String)
  print (Right "x" :: Either Int String)
  print (BinOp Plus (Num 1) (Neg (Num (-2))))
  print (Pair 'a' (Pair [True] ()))
  print "tab\there \"quoted\" \\ done"
  print 'q'
  print '\''
  print "\1234\&5 \233"
  print ""
  print ([] :: [Int])
  print [[1, 2], [3]]
  print ["a", "b"]
  print (Just "")
  print Minus
  putStrLn (show 42 ++ "!")
