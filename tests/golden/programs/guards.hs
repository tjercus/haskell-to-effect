module Main where

fizzbuzz :: Int -> String
fizzbuzz n
  | n `mod` 15 == 0 = "FizzBuzz"
  | n `mod` 3 == 0 = "Fizz"
  | n `mod` 5 == 0 = "Buzz"
  | otherwise = show n

isEven, isOdd :: Int -> Bool
isEven 0 = True
isEven n = isOdd (n - 1)
isOdd 0 = False
isOdd n = isEven (n - 1)

collatz :: Int -> Int
collatz 1 = 0
collatz n = 1 + collatz next
  where
    next
      | isEven n = n `div` 2
      | otherwise = 3 * n + 1

sign :: Int -> Int
sign n
  | n < 0 = -1
  | n == 0 = 0
  | otherwise = 1

main :: IO ()
main = do
  mapM_ (putStrLn . fizzbuzz) [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
  print (isEven 10, isOdd 7)
  print (collatz 27)
  print (map sign [-5, 0, 3])
  print (div 7 2, mod 7 2, div (-7) 2, mod (-7) 2)
