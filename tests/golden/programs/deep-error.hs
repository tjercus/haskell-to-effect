-- A runtime error deep inside non-tail recursion.
module Main where

boom :: Int -> Int
boom n = if n == 0 then error "bottom" else 1 + boom (n - 1)

main :: IO ()
main = do
  putStrLn "start"
  print (boom 100000)
  putStrLn "not reached"
